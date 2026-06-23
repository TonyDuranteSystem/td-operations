/**
 * Slack interactive components webhook — Claude bot (app A0B9LUJRLMB)
 *
 * Handles:
 *  - "⏹ Stop" button (block_actions, action_id=stop_thinking) — cancels the
 *    in-flight agent_messages row (unchanged behavior).
 *  - Client-conversation form (Phase 2, dev_task 54f89912):
 *      • block_actions  / open_client_conversation  → opens the modal (views.open)
 *      • block_suggestion / client_select           → live CRM client search (options)
 *      • view_submission / client_conversation_modal → starts a labeled, tagged thread
 *
 * Slack delivers interactivity payloads as application/x-www-form-urlencoded with a
 * single `payload` JSON field. Signature verification is identical to the events
 * webhook (HMAC-SHA256, SLACK_SIGNING_SECRET_CLAUDE).
 *
 * Setup: in the Slack app's "Interactivity & Shortcuts": Request URL → this route
 * (already set; the Stop button proves it). For the live client dropdown, set the
 * "Select menus" Options Load URL → this same route. See slack-claude-worker.md.
 *
 * Public path (/api/webhooks/*) — auth-exempt in middleware, blocked in sandbox by
 * SANDBOX_MODE. Production-only, like the rest of slack-claude.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { getInternalBaseUrl } from "@/lib/mcp/tools/agent-messages"
import {
  verifySlackSignature,
  parseSlackInteractionFull,
  updateSlackMessage,
  openClientConversationModal,
  searchClientsForSlackOptions,
  findOpenConversationForEntityTopic,
  buildDuplicateConfirmView,
  ensureTopicSlugFromText,
  STOP_THINKING_ACTION_ID,
  FOLLOW_CLIENT_THREAD_ACTION_ID,
  CLOSE_CLIENT_THREAD_ACTION_ID,
  REOPEN_CLIENT_THREAD_ACTION_ID,
  REMOVE_CLIENT_THREAD_ACTION_ID,
  OPEN_CLIENT_CONVERSATION_ACTION_ID,
  CLIENT_CONVERSATION_SHORTCUT_CALLBACK,
  CLIENT_CONVERSATION_MODAL_CALLBACK,
  CLIENT_SELECT_ACTION_ID,
  TOPIC_SELECT_ACTION_ID,
  NEW_TOPIC_BLOCK_ID,
  NEW_TOPIC_ACTION_ID,
  CHANNEL_SELECT_BLOCK_ID,
  CHANNEL_SELECT_ACTION_ID,
} from "@/lib/ai-agent/slack-claude"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function selectedValue(viewState: any, blockId: string, actionId: string): string | null {
  const sel = viewState?.values?.[blockId]?.[actionId]?.selected_option
  return (sel?.value as string | undefined) ?? null
}

// conversations_select returns `selected_conversation` (a channel id), not selected_option.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function selectedConversation(viewState: any, blockId: string, actionId: string): string | null {
  const v = viewState?.values?.[blockId]?.[actionId]?.selected_conversation
  return (typeof v === "string" && v) ? v : null
}

/**
 * Fire-and-forget the actual thread creation to a background endpoint so the modal
 * submit can respond within Slack's ~3s window even on a cold start. Mirrors
 * fireWorkerTrigger in the @Claude events path: we await only long enough to
 * dispatch the request, then abort — the background function keeps running
 * server-side and does the slow chat.postMessage + client_threads insert.
 */
async function fireClientThreadCreate(args: {
  channelId: string
  notifyChannel?: string
  userId: string | null
  clientValue: string
  topicSlug: string
}): Promise<void> {
  await fireBackground("/api/cron/client-thread-create", args)
}

/** Fire-and-forget the "👀 Follow" toggle to its background endpoint (see that route). */
async function fireFollowToggle(args: {
  channelId: string
  messageTs: string
  userId: string
}): Promise<void> {
  await fireBackground("/api/cron/client-thread-follow", args)
}

/** Fire-and-forget a card lifecycle action (close/reopen/remove) to its endpoint. */
async function fireCardAction(args: {
  action: "close" | "reopen" | "remove"
  channelId: string
  messageTs: string
  userId: string
}): Promise<void> {
  await fireBackground("/api/cron/client-thread-action", args)
}

/** Shared fire-and-forget POST to an internal /api/cron endpoint (1.5s dispatch cap). */
async function fireBackground(path: string, args: Record<string, unknown>): Promise<void> {
  const url = `${getInternalBaseUrl()}${path}`
  const cronSecret = process.env.CRON_SECRET ?? ""
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1500)
  try {
    await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cronSecret}`, "content-type": "application/json" },
      body: JSON.stringify(args),
      signal: controller.signal,
    })
  } catch {
    // AbortError is expected — the background function keeps running server-side.
  } finally {
    clearTimeout(timeout)
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text()
  const timestamp = req.headers.get("x-slack-request-timestamp") ?? ""
  const signature = req.headers.get("x-slack-signature") ?? ""

  if (!verifySlackSignature(rawBody, timestamp, signature, process.env.SLACK_SIGNING_SECRET_CLAUDE)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  const it = parseSlackInteractionFull(rawBody)
  if (!it) return NextResponse.json({ ok: true })

  // ── Live client search for the modal's external_select ─────────────────────
  if (it.type === "block_suggestion" && it.actionId === CLIENT_SELECT_ACTION_ID) {
    const options = await searchClientsForSlackOptions(it.suggestionValue ?? "")
    return NextResponse.json({ options })
  }

  // ── Modal submit → start the labeled, tagged thread ────────────────────────
  if (it.type === "view_submission" && it.viewCallbackId === CLIENT_CONVERSATION_MODAL_CALLBACK) {
    // "Start new anyway" confirm step: private_metadata is JSON with confirm:true,
    // carrying the original selection. Skip the dedup check and create directly.
    let confirm: { channel?: string; notifyChannel?: string; clientValue?: string; topicSlug?: string } | null = null
    try {
      const j = JSON.parse(it.viewPrivateMetadata ?? "")
      if (j && j.confirm) confirm = j
    } catch {
      /* initial submit — private_metadata is the plain channel id */
    }

    if (confirm) {
      if (!confirm.channel || !confirm.clientValue || !confirm.topicSlug) return NextResponse.json({})
      // Create in the background so we respond within Slack's 3s window.
      await fireClientThreadCreate({
        channelId: confirm.channel,
        notifyChannel: confirm.notifyChannel ?? confirm.channel,
        userId: it.userId,
        clientValue: confirm.clientValue,
        topicSlug: confirm.topicSlug,
      })
      return NextResponse.json({})
    }

    // Where the modal was opened from (the bot is reachable here for error feedback).
    const invokingChannel = it.viewPrivateMetadata
    // Where to post the conversation — the picked channel, else the invoking channel.
    const targetChannel =
      selectedConversation(it.viewState, CHANNEL_SELECT_BLOCK_ID, CHANNEL_SELECT_ACTION_ID) || invokingChannel
    const clientValue = selectedValue(it.viewState, "client_block", CLIENT_SELECT_ACTION_ID)
    // A typed new topic wins over the dropdown; ensure it's a catalog slug (reusable next time).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newTopicText = ((it.viewState as any)?.values?.[NEW_TOPIC_BLOCK_ID]?.[NEW_TOPIC_ACTION_ID]?.value ?? "")
      .toString()
      .trim()
    let topicSlug = selectedValue(it.viewState, "topic_block", TOPIC_SELECT_ACTION_ID)
    if (newTopicText) topicSlug = await ensureTopicSlugFromText(newTopicText)

    if (!targetChannel || !clientValue) {
      return NextResponse.json({
        response_action: "errors",
        errors: { client_block: "Pick a client to start." },
      })
    }
    if (!topicSlug) {
      return NextResponse.json({
        response_action: "errors",
        errors: { topic_block: "Pick a topic or type a new one." },
      })
    }

    // Dedup: if an OPEN conversation already exists for this client+topic, don't
    // create a duplicate — update the modal to propose continuing the existing one.
    const existing = await findOpenConversationForEntityTopic(clientValue, topicSlug)
    if (existing) {
      return NextResponse.json({
        response_action: "update",
        view: buildDuplicateConfirmView({
          channel: targetChannel,
          notifyChannel: invokingChannel ?? targetChannel,
          clientValue,
          topicSlug,
          clientName: existing.clientName,
          openedAt: existing.openedAt,
          slackLink: existing.slackLink,
        }),
      })
    }

    // No open duplicate — create in the background so we respond within Slack's 3s
    // window (cold-start of chat.postMessage + insert can otherwise exceed it and
    // surface "We had some trouble connecting" even though the thread was created).
    await fireClientThreadCreate({
      channelId: targetChannel,
      notifyChannel: invokingChannel ?? targetChannel,
      userId: it.userId,
      clientValue,
      topicSlug,
    })
    // Empty 200 closes the modal cleanly.
    return NextResponse.json({})
  }

  // ── Global shortcut (⚡ menu, always available) → open the modal ────────────
  // A global shortcut carries no channel, so the new thread defaults to #td-support
  // (SLACK_SUPPORT_CHANNEL_ID). This is the persistent entry point that never scrolls away.
  if (it.type === "shortcut" && it.shortcutCallbackId === CLIENT_CONVERSATION_SHORTCUT_CALLBACK) {
    const channelId = process.env.SLACK_SUPPORT_CHANNEL_ID
    if (!it.triggerId || !channelId) return NextResponse.json({ ok: true })
    await openClientConversationModal(it.triggerId, channelId)
    return NextResponse.json({ ok: true })
  }

  // ── Button (in-channel, optional): open the client-conversation modal ──────
  if (it.type === "block_actions" && it.actionId === OPEN_CLIENT_CONVERSATION_ACTION_ID) {
    if (!it.triggerId || !it.channelId) return NextResponse.json({ ok: true })
    await openClientConversationModal(it.triggerId, it.channelId)
    return NextResponse.json({ ok: true })
  }

  // ── "👀 Follow" button → toggle a per-user follow (work runs in the background) ─
  if (it.type === "block_actions" && it.actionId === FOLLOW_CLIENT_THREAD_ACTION_ID) {
    if (it.channelId && it.messageTs && it.userId) {
      await fireFollowToggle({ channelId: it.channelId, messageTs: it.messageTs, userId: it.userId })
    }
    return NextResponse.json({ ok: true })
  }

  // ── 🗂️ card lifecycle buttons: ✅ Close · ↩️ Reopen · 🗑️ Remove (background) ────
  {
    const cardAction =
      it.actionId === CLOSE_CLIENT_THREAD_ACTION_ID
        ? "close"
        : it.actionId === REOPEN_CLIENT_THREAD_ACTION_ID
          ? "reopen"
          : it.actionId === REMOVE_CLIENT_THREAD_ACTION_ID
            ? "remove"
            : null
    if (it.type === "block_actions" && cardAction) {
      if (it.channelId && it.messageTs && it.userId) {
        await fireCardAction({
          action: cardAction,
          channelId: it.channelId,
          messageTs: it.messageTs,
          userId: it.userId,
        })
      }
      return NextResponse.json({ ok: true })
    }
  }

  // ── "⏹ Stop" button (unchanged) ────────────────────────────────────────────
  if (it.type === "block_actions" && it.actionId === STOP_THINKING_ACTION_ID) {
    const { messageTs, channelId } = it
    if (!messageTs || !channelId) return NextResponse.json({ ok: true })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: cancelled, error } = await (supabaseAdmin as any)
      .from("agent_messages")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("recipient", "claude")
      .filter("context_json->>slack_ack_ts", "eq", messageTs)
      .filter("context_json->>slack_channel_id", "eq", channelId)
      .in("status", ["pending", "processing"])
      .select("id")

    if (error) {
      console.error("[slack-interactions] cancel update failed:", error)
      return NextResponse.json({ ok: true })
    }

    if (cancelled?.length) {
      await updateSlackMessage(channelId, messageTs, "⏹ Stopped — go ahead with your update", []).catch(
        (err) => {
          console.error("[slack-interactions] stop message update failed:", err)
          return false
        },
      )
    }
    return NextResponse.json({ ok: true })
  }

  // ACK any unrelated/unknown interaction so Slack doesn't surface an error.
  return NextResponse.json({ ok: true })
}
