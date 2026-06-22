/**
 * Client Threads — per-user "Follow" + personal DM digest (dev_task 54f89912).
 *
 * Slack gives apps no API to follow a thread or save to "Later" for a user
 * (verified 2026-06-22). So a "👀 Follow" button on the 🗂️ folder message toggles a
 * row in client_thread_follows for the clicking user, and the bot keeps ONE message in
 * that user's DM ("📌 Following") listing their followed + still-open conversations,
 * each a clickable permalink. A closed conversation drops off because the digest query
 * filters client_threads.status = 'open'.
 *
 * Tables: client_thread_follows, slack_follow_digests (migration 20260622-1300).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { getSlackPermalink, slackApiCall } from "./slack-claude"

const DIGEST_CAP = 50

export interface FollowDigestRow {
  clientName: string
  topic: string
  openedAt: string | null
  permalink: string | null
}

/** Format an ISO timestamp like "Jun 22, 3:04 PM" for the DM list. */
function fmtOpened(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
  } catch {
    return ""
  }
}

/**
 * Pure renderer for the per-user "📌 Following" DM text. Exported for unit tests.
 * Each row is a Slack mrkdwn link (label can't carry *bold*, so it's plain text).
 */
export function renderFollowDigestText(rows: FollowDigestRow[]): string {
  if (rows.length === 0) {
    return (
      "📌 *Your followed conversations*\n" +
      "You're not following any open conversations right now. Tap *👀 Follow* on a 🗂️ conversation to track it here until it closes."
    )
  }
  const lines = rows.map((r) => {
    const opened = r.openedAt ? ` · opened ${fmtOpened(r.openedAt)}` : ""
    const label = `${r.clientName} · ${r.topic}`
    return r.permalink ? `• <${r.permalink}|${label}>${opened}` : `• ${label}${opened}`
  })
  return `📌 *Your followed conversations* (${rows.length})\n${lines.join("\n")}`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveEntityName(db: any, row: { account_id?: string | null; contact_id?: string | null; lead_id?: string | null }): Promise<string> {
  try {
    if (row.account_id) {
      const { data } = await db.from("accounts").select("company_name").eq("id", row.account_id).maybeSingle()
      return data?.company_name ?? "Client"
    }
    if (row.contact_id) {
      const { data } = await db.from("contacts").select("full_name").eq("id", row.contact_id).maybeSingle()
      return data?.full_name ?? "Client"
    }
    if (row.lead_id) {
      const { data } = await db.from("leads").select("full_name").eq("id", row.lead_id).maybeSingle()
      return data?.full_name ?? "Client"
    }
  } catch {
    /* keep default */
  }
  return "Client"
}

/** Resolve a client_threads id from a Slack "channel:thread_ts" source_ref. */
export async function resolveClientThreadIdBySourceRef(sourceRef: string): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data } = await db
    .from("client_threads")
    .select("id")
    .eq("source", "slack")
    .eq("source_ref", sourceRef)
    .maybeSingle()
  return data?.id ?? null
}

/** Toggle a follow for (thread, user). Returns the new state. */
export async function toggleFollow(
  clientThreadId: string,
  slackUserId: string,
): Promise<{ following: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: existing } = await db
    .from("client_thread_follows")
    .select("id")
    .eq("client_thread_id", clientThreadId)
    .eq("slack_user_id", slackUserId)
    .maybeSingle()
  if (existing) {
    await db.from("client_thread_follows").delete().eq("id", existing.id)
    return { following: false }
  }
  // Insert; tolerate a race where another click inserted first (unique constraint).
  const { error } = await db
    .from("client_thread_follows")
    .insert({ client_thread_id: clientThreadId, slack_user_id: slackUserId })
  if (error && !/duplicate key/i.test(error.message ?? "")) {
    console.error("[client-thread-follows] follow insert failed:", error)
  }
  return { following: true }
}

/** Slack user ids of everyone following a given thread. */
export async function getFollowersOfThread(clientThreadId: string): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data } = await db
    .from("client_thread_follows")
    .select("slack_user_id")
    .eq("client_thread_id", clientThreadId)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((r: any) => r.slack_user_id as string)
}

/**
 * Rebuild a user's "📌 Following" DM message from the DB (followed + open threads).
 * Edits the existing DM message (chat.update) when we have its ts, else posts fresh
 * and remembers it. Best-effort — never throws.
 */
export async function refreshUserFollowDigest(slackUserId: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  try {
    const { data: follows } = await db
      .from("client_thread_follows")
      .select(
        "client_threads!inner(id, account_id, contact_id, lead_id, topic_slug, source_ref, status, created_at)",
      )
      .eq("slack_user_id", slackUserId)
      .eq("client_threads.status", "open")

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const threads: any[] = (follows ?? [])
      .map((f: { client_threads: unknown }) => f.client_threads)
      .filter(Boolean)
      .sort(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      )
      .slice(0, DIGEST_CAP)

    const rows: FollowDigestRow[] = []
    for (const t of threads) {
      const clientName = await resolveEntityName(db, t)
      let permalink: string | null = null
      if (typeof t.source_ref === "string" && t.source_ref.includes(":")) {
        const [ch, ts] = t.source_ref.split(":")
        if (ch && ts) permalink = await getSlackPermalink(ch, ts)
      }
      rows.push({ clientName, topic: t.topic_slug ?? "general", openedAt: t.created_at ?? null, permalink })
    }

    const text = renderFollowDigestText(rows)

    const { data: dig } = await db
      .from("slack_follow_digests")
      .select("dm_channel_id, message_ts")
      .eq("slack_user_id", slackUserId)
      .maybeSingle()

    if (dig?.dm_channel_id && dig?.message_ts) {
      const upd = await slackApiCall("chat.update", { channel: dig.dm_channel_id, ts: dig.message_ts, text })
      if (upd.ok) return
      // else fall through to re-post (message may have been deleted)
    }

    const posted = (await slackApiCall("chat.postMessage", { channel: slackUserId, text })) as unknown as {
      ok: boolean
      ts?: string
      channel?: string
    }
    if (posted.ok && posted.ts) {
      await db.from("slack_follow_digests").upsert(
        {
          slack_user_id: slackUserId,
          dm_channel_id: posted.channel ?? slackUserId,
          message_ts: posted.ts,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "slack_user_id" },
      )
    }
  } catch (err) {
    console.error("[client-thread-follows] refreshUserFollowDigest failed:", err)
  }
}

/** Refresh the DM list of every follower of a thread (used on close/reopen). */
export async function refreshFollowersDigests(clientThreadId: string): Promise<void> {
  const followers = await getFollowersOfThread(clientThreadId)
  for (const u of followers) {
    await refreshUserFollowDigest(u)
  }
}

/**
 * Remove a conversation card (🗑️ reaction on the 🗂️ root message): delete the Slack
 * folder message AND the client_threads row (CASCADE removes its follows), then refresh
 * the DM list of everyone who was following it. For clearing mistaken/duplicate cards.
 * Ignores reactions on non-card messages (source_ref not found). Best-effort.
 */
export async function removeClientThreadCard(args: {
  channelId: string
  messageTs: string
  reactedBy: string | null
}): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const sourceRef = `${args.channelId}:${args.messageTs}`
  const { data: ct } = await db
    .from("client_threads")
    .select("id")
    .eq("source", "slack")
    .eq("source_ref", sourceRef)
    .maybeSingle()
  if (!ct) return // not a conversation card — ignore the reaction

  // Capture followers BEFORE deleting (the follow rows cascade away with the thread).
  const followers = await getFollowersOfThread(ct.id)

  // Delete the Slack folder message (the bot authored it → deletable with chat:write).
  await slackApiCall("chat.delete", { channel: args.channelId, ts: args.messageTs })

  // Delete the row; client_thread_follows rows cascade (FK ON DELETE CASCADE).
  await db.from("client_threads").delete().eq("id", ct.id)

  // Each ex-follower's DM list should drop the removed card.
  for (const u of followers) {
    await refreshUserFollowDigest(u)
  }

  if (args.reactedBy) {
    await slackApiCall("chat.postEphemeral", {
      channel: args.channelId,
      user: args.reactedBy,
      text: "🗑️ Removed this conversation card and its CRM entry.",
    })
  }
}

/**
 * Full handler for a "👀 Follow" button click: resolve the thread from the clicked
 * message (channel:ts), toggle the follow, post an ephemeral confirmation, and refresh
 * the user's DM list. Runs in the background endpoint so it never blocks Slack's 3s ACK.
 */
export async function handleFollowToggle(args: {
  channelId: string
  messageTs: string
  userId: string
}): Promise<void> {
  const sourceRef = `${args.channelId}:${args.messageTs}`
  const threadId = await resolveClientThreadIdBySourceRef(sourceRef)
  if (!threadId) {
    await slackApiCall("chat.postEphemeral", {
      channel: args.channelId,
      user: args.userId,
      text: "Couldn't find this conversation to follow — try again from the 🗂️ message.",
    })
    return
  }

  const { following } = await toggleFollow(threadId, args.userId)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: row } = await db
    .from("client_threads")
    .select("account_id, contact_id, lead_id, topic_slug")
    .eq("id", threadId)
    .maybeSingle()
  const name = row ? await resolveEntityName(db, row) : "this conversation"
  const topic = row?.topic_slug ?? "general"

  const text = following
    ? `👀 Following *${name} · ${topic}* — it's in your *📌 Following* DM list until it closes.`
    : `Unfollowed *${name} · ${topic}* — removed from your *📌 Following* list.`
  await slackApiCall("chat.postEphemeral", { channel: args.channelId, user: args.userId, text })

  await refreshUserFollowDigest(args.userId)
}
