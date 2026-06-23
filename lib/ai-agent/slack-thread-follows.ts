/**
 * Follow ANY Slack thread via 👀 + a per-channel "Followed conversations" Canvas.
 *
 * Distinct from client_threads / client_thread_follows (which are client+topic-tagged
 * /client cards): here a user 👀-reacts on ANY thread (even a plain @Claude question) to
 * track it, and each channel gets its OWN Canvas listing the threads followed there.
 * 👀 added = follow; 👀 removed = unfollow (needs the reaction_removed event subscribed).
 *
 * Tables: slack_thread_follows, slack_channel_canvas (migration 20260623-1900).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { slackApiCall, buildSlackThreadDeepLink, fetchSlackMessageText } from "./slack-claude"

const CANVAS_CAP = 50
const LABEL_MAX = 80

export interface ChannelFollowRow {
  label: string
  channelId: string
  threadTs: string
  createdAt: string | null
}

/** Pure renderer for a channel's "Followed conversations" Canvas. Exported for tests. */
export function renderChannelCanvasMarkdown(rows: ChannelFollowRow[]): string {
  const header =
    "# 🗂️ Followed conversations\n\n_Threads someone on the team is following in this channel. Tap one to open it. React 👀 on a thread to follow it; remove 👀 to unfollow._\n\n"
  if (rows.length === 0) {
    return header + "_No followed conversations in this channel yet. React 👀 on a thread to add it._"
  }
  const lines = rows.map((r) => {
    const link = buildSlackThreadDeepLink(r.channelId, r.threadTs)
    const label = (r.label || "conversation").replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) || "conversation"
    return `- [${label}](${link})`
  })
  return header + lines.join("\n")
}

/** Record a follow (idempotent on channel+thread+user). */
export async function followThread(
  channelId: string,
  threadTs: string,
  slackUserId: string,
  label: string | null,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { error } = await db
    .from("slack_thread_follows")
    .upsert(
      { channel_id: channelId, thread_ts: threadTs, slack_user_id: slackUserId, label },
      { onConflict: "channel_id,thread_ts,slack_user_id" },
    )
  if (error) console.error("[slack-thread-follows] followThread failed:", error)
}

/** Remove a follow. */
export async function unfollowThread(channelId: string, threadTs: string, slackUserId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  await db
    .from("slack_thread_follows")
    .delete()
    .eq("channel_id", channelId)
    .eq("thread_ts", threadTs)
    .eq("slack_user_id", slackUserId)
}

/**
 * The one maintained Canvas id for a channel (stored once → no duplicate-create bug).
 * Creates it (titled) on first use. Returns null on failure.
 */
async function ensureChannelCanvas(channelId: string): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data } = await db.from("slack_channel_canvas").select("canvas_id").eq("channel_id", channelId).maybeSingle()
  if (data?.canvas_id) return data.canvas_id as string

  const created = (await slackApiCall("conversations.canvases.create", {
    channel_id: channelId,
    title: "Followed conversations",
    document_content: { type: "markdown", markdown: "# 🗂️ Followed conversations" },
  })) as unknown as { ok: boolean; canvas_id?: string; error?: string }
  if (created.ok && created.canvas_id) {
    await db
      .from("slack_channel_canvas")
      .upsert(
        { channel_id: channelId, canvas_id: created.canvas_id, updated_at: new Date().toISOString() },
        { onConflict: "channel_id" },
      )
    return created.canvas_id
  }
  console.error("[slack-thread-follows] canvas create failed for", channelId, created.error)
  return null
}

/** Rebuild a channel's "Followed conversations" Canvas from the DB. Best-effort. */
export async function refreshChannelFollowCanvas(channelId: string): Promise<{ ok: boolean; error?: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  try {
    const { data } = await db
      .from("slack_thread_follows")
      .select("thread_ts, label, created_at")
      .eq("channel_id", channelId)
      .order("created_at", { ascending: false })
      .limit(CANVAS_CAP * 4)

    // Dedupe by thread_ts (several users may follow the same thread).
    const seen = new Set<string>()
    const rows: ChannelFollowRow[] = []
    for (const r of data ?? []) {
      if (seen.has(r.thread_ts)) continue
      seen.add(r.thread_ts)
      rows.push({ label: r.label ?? "conversation", channelId, threadTs: r.thread_ts, createdAt: r.created_at ?? null })
      if (rows.length >= CANVAS_CAP) break
    }

    const canvasId = await ensureChannelCanvas(channelId)
    if (!canvasId) return { ok: false, error: "no canvas id" }
    const edit = (await slackApiCall("canvases.edit", {
      canvas_id: canvasId,
      changes: [
        { operation: "replace", document_content: { type: "markdown", markdown: renderChannelCanvasMarkdown(rows) } },
      ],
    })) as { ok: boolean; error?: string }
    if (!edit.ok) return { ok: false, error: edit.error ?? "canvases.edit failed" }
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[slack-thread-follows] refreshChannelFollowCanvas failed:", err)
    return { ok: false, error: msg }
  }
}

/**
 * Entry point from the 👀 reaction handler: follow/unfollow the reacted thread for the
 * user, then rebuild that channel's Canvas. The reacted message ts is the thread anchor.
 */
export async function handleThreadFollowReaction(args: {
  channelId: string
  messageTs: string
  userId: string
  added: boolean
}): Promise<void> {
  if (args.added) {
    const text = (await fetchSlackMessageText(args.channelId, args.messageTs)) ?? "conversation"
    const label = text.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) || "conversation"
    await followThread(args.channelId, args.messageTs, args.userId, label)
  } else {
    await unfollowThread(args.channelId, args.messageTs, args.userId)
  }
  await refreshChannelFollowCanvas(args.channelId)
}
