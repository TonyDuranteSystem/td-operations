/**
 * Slack Events API webhook — Claude bot (app A0B9LUJRLMB)
 *
 * Receives app_mention events (and follow-up thread-reply `message` events in
 * threads Claude already participated in) from Slack, immediately posts
 * "On it 👍" so Antonio has instant acknowledgment (< 2s), then queues the
 * message for the Slack worker cron to process with the full Claude AI response.
 *
 * NOTE: thread-reply support requires the Slack app to subscribe to the
 * `message.channels` bot event in addition to `app_mention`.
 *
 * Flow:
 *   1. Verify Slack signing secret (HMAC-SHA256)
 *   2. Handle URL verification challenge (one-time Slack app setup)
 *   3. Skip bot messages (loop protection)
 *   4. Duplicate-event guard (idempotency via Slack event_id)
 *   5. Post immediate "On it 👍" acknowledgment to Slack
 *   6. Find or create conversation thread_id for this scope
 *   7. INSERT agent_messages row (sender='slack', recipient='claude')
 *   8. Fire direct trigger to /api/cron/slack-claude-worker (bounded 2.5s)
 *   9. Return 200
 *
 * The 200 response satisfies Slack's 3-second ACK requirement before the
 * worker does the actual Claude API call (8–15s).
 *
 * SANDBOX_MODE=1 blocks /api/webhooks/* — the Slack app Event Subscription
 * URL must point to the production deployment. Test the worker independently
 * via direct POST to /api/cron/slack-claude-worker.
 */

export const dynamic = "force-dynamic"

import { createHmac, timingSafeEqual } from "crypto"
import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  postSlackMessage,
  buildThinkingBlocks,
  findOrCreateConversationThread,
  fetchSlackMessageText,
  slackScopeKey,
  collectSlackReferences,
  SLACK_SUPPORTED_IMAGE_TYPES,
  SLACK_MAX_IMAGE_BYTES,
} from "@/lib/ai-agent/slack-claude"
import { getInternalBaseUrl } from "@/lib/mcp/tools/agent-messages"

// Claude bot user ID — used to filter out self-messages (loop protection)
const CLAUDE_BOT_USER_ID = "U0B9S675WTT"

// Antonio's Slack user ID. Only his thread reply counts as an answer to a
// pending ask-antonio code-task question (matches SLACK_USER_ANTONIO in
// lib/ai-agent/slack-claude.ts and ANTONIO_SLACK_USER_ID in the Mac Mini CLI).
const ANTONIO_SLACK_USER_ID = "U0BAALR4Y4Q"

function verifySlackSignature(rawBody: string, timestamp: string, signature: string): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET_CLAUDE
  if (!secret) {
    console.warn("[slack-claude-webhook] SLACK_SIGNING_SECRET_CLAUDE not set — rejecting")
    return false
  }
  // Reject replays older than 5 minutes
  const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10))
  if (age > 300) return false

  const base = `v0:${timestamp}:${rawBody}`
  const computed = `v0=${createHmac("sha256", secret).update(base).digest("hex")}`
  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(signature))
  } catch {
    return false
  }
}

async function isDuplicateEvent(eventId: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabaseAdmin as any)
    .from("agent_messages")
    .select("id")
    .filter("context_json->>slack_event_id", "eq", eventId)
    .limit(1)
  return (data?.length ?? 0) > 0
}

/**
 * Fetch the parent (root) message of a thread and report whether it @mentioned
 * Claude. This is the "was Claude invited to THIS thread" check for a plain
 * (no-@mention) thread reply — it replaces the old channel-level participation
 * query that leaked Claude into unrelated threads (e.g. Hermes-only threads) in
 * any channel where Claude had ever spoken at the top level.
 *
 * Mirrors the single-message-by-ts fetch the 🧠-reaction handler already uses
 * (`conversations.history` at the exact ts). Best-effort: any failure — missing
 * token, missing scope, network error, message not found — returns false so
 * Claude stays quiet. That is the safe default here, because the bug being fixed
 * is Claude over-responding; a rare transient miss just means Antonio re-mentions.
 */
async function parentMessageMentionsClaude(channelId: string, threadTs: string): Promise<boolean> {
  const token = process.env.SLACK_BOT_TOKEN_CLAUDE
  if (!token || !channelId || !threadTs) return false
  try {
    const res = await fetch(
      `https://slack.com/api/conversations.history?channel=${channelId}&latest=${threadTs}&inclusive=true&limit=1`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      messages?: Array<{ text?: string }>
    }
    const parentText = data.messages?.[0]?.text ?? ""
    return parentText.includes(`<@${CLAUDE_BOT_USER_ID}>`)
  } catch (err) {
    console.warn("[slack-claude-webhook] parent-message fetch failed:", err)
    return false
  }
}

async function fireWorkerTrigger(messageId: string): Promise<void> {
  const url = `${getInternalBaseUrl()}/api/cron/slack-claude-worker?message_id=${encodeURIComponent(messageId)}`
  const cronSecret = process.env.CRON_SECRET ?? ""
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2500)
  try {
    await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cronSecret}` },
      signal: controller.signal,
    })
  } catch {
    // AbortError is expected — the worker keeps running server-side after the timeout.
    // Cron is the safety net for any direct trigger that doesn't reach the worker.
  } finally {
    clearTimeout(timeout)
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text()

  const timestamp = req.headers.get("x-slack-request-timestamp") ?? ""
  const signature = req.headers.get("x-slack-signature") ?? ""

  if (!verifySlackSignature(rawBody, timestamp, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let payload: Record<string, any>
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 })
  }

  // Slack URL verification challenge (one-time, when adding Event Subscriptions)
  if (payload.type === "url_verification") {
    return NextResponse.json({ challenge: payload.challenge })
  }

  // Only handle event_callback type
  if (payload.type !== "event_callback") {
    return NextResponse.json({ ok: true })
  }

  const event = payload.event ?? {}
  const eventId: string = payload.event_id ?? ""

  // ── Client Threads: ✅ reaction on a conversation's STARTING message → close it ──
  // Only the labeled root message has `${channel}:${ts}` as a client_threads.source_ref
  // (thread replies have different ts), so this is deliberate — react ✅ on the start
  // message to close. Snapshots the transcript (frozen record). Needs the same
  // reaction_added subscription as the 🧠 handler below.
  if (event.type === "reaction_added" && event.reaction === "white_check_mark") {
    if (event.user === CLAUDE_BOT_USER_ID) return NextResponse.json({ ok: true })
    const itemChannel: string = event.item?.channel ?? ""
    const itemTs: string = event.item?.ts ?? ""
    if (itemChannel && itemTs) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: ct } = await (supabaseAdmin as any)
        .from("client_threads")
        .select("id, status")
        .eq("source", "slack")
        .eq("source_ref", `${itemChannel}:${itemTs}`)
        .maybeSingle()
      if (ct && ct.status !== "closed") {
        try {
          const { closeClientThread } = await import("@/lib/ai-agent/slack-claude")
          await closeClientThread(ct.id, null)
          return NextResponse.json({ ok: true, closed: ct.id })
        } catch (err) {
          console.warn("[slack-claude-webhook] ✅ close failed:", err)
        }
      }
    }
    return NextResponse.json({ ok: true })
  }

  // ── Decision Memory Phase 7: 🧠 reaction → save the message as a memory ──
  // Slack delivers reaction_added as an event_callback. The app must subscribe
  // to the `reaction_added` bot event for these to arrive (admin config — noted
  // in the deploy report). When someone reacts with 🧠, persist the reacted
  // message as an explicit decision memory.
  if (event.type === "reaction_added" && event.reaction === "brain") {
    // Ignore the bot reacting to itself (loop / accidental self-mark).
    if (event.user === CLAUDE_BOT_USER_ID) {
      return NextResponse.json({ ok: true })
    }
    const token = process.env.SLACK_BOT_TOKEN_CLAUDE
    const itemChannel: string = event.item?.channel ?? ""
    const itemTs: string = event.item?.ts ?? ""
    if (!token || !itemChannel || !itemTs) {
      return NextResponse.json({ ok: true })
    }

    const sourceRef = `${itemChannel}:${itemTs}`
    // Idempotency: a user can react / un-react / re-react, and Slack retries
    // deliveries. Skip if this exact message was already saved.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existing } = await (supabaseAdmin as any)
      .from("decision_memory")
      .select("id")
      .eq("source_ref", sourceRef)
      .eq("source_type", "slack_reaction")
      .limit(1)
    if (existing?.length) {
      return NextResponse.json({ ok: true, dedup: "already_saved" })
    }

    // Fetch the reacted message text — robust to thread replies. Using
    // conversations.history alone returned the parent (wrong) message when the
    // reaction was on a thread reply; fetchSlackMessageText verifies the exact ts
    // and falls back to conversations.replies. (Bug found 2026-06-18 during the
    // first live 🧠 test — a reply was saved as its parent question.)
    const msgText = await fetchSlackMessageText(itemChannel, itemTs)
    if (!msgText) {
      return NextResponse.json({ ok: true, skipped: "no_text" })
    }

    const decision = msgText.replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, "").trim()
    if (!decision) {
      return NextResponse.json({ ok: true, skipped: "empty_after_strip" })
    }

    try {
      const { saveDecisionMemory } = await import("@/lib/ai-agent/decision-memory")
      await saveDecisionMemory({
        situation: "Explicitly marked important by Antonio via 🧠 reaction in Slack",
        decision,
        sourceType: "slack_reaction",
        sourceRef,
        actors: ["antonio"],
        tags: ["explicit_save"],
      })
    } catch (err) {
      console.warn("[slack-claude-webhook] brain reaction save failed:", err)
      return NextResponse.json({ ok: true, saved: false })
    }
    return NextResponse.json({ ok: true, saved: true })
  }

  // Accept two kinds of events:
  //  1. app_mention — Antonio @mentions Claude (any channel, any context)
  //  2. message in a thread — a follow-up reply in a thread Claude already
  //     participated in. We allow no-subtype (genuine human text) AND
  //     subtype="file_share" (a screenshot dropped into the thread with no
  //     @mention — Slack tags pure file uploads with this subtype). All other
  //     subtypes (message_changed, message_deleted, channel_join, bot_message…)
  //     are still excluded, so edits/deletes/joins don't re-trigger. Bot loop
  //     protection below (event.bot_id) still rejects file_shares from any bot.
  const isAppMention = event.type === "app_mention"
  const isThreadReply =
    event.type === "message" &&
    !!event.thread_ts &&
    (!event.subtype || event.subtype === "file_share")

  if (!isAppMention && !isThreadReply) {
    return NextResponse.json({ ok: true })
  }

  // Loop protection: skip messages from bots (including ourselves). MUST run
  // before the participation query/insert — every reply Claude posts fires a
  // `message` event carrying bot_id, and this is what stops the infinite loop.
  if (event.bot_id || event.user === CLAUDE_BOT_USER_ID || event.subtype === "bot_message") {
    return NextResponse.json({ ok: true })
  }

  const channelId: string = event.channel ?? ""
  const threadTs: string | null = event.thread_ts ?? null  // set when message is in a thread
  const eventTs: string = event.ts ?? ""
  const text: string = event.text ?? ""
  const userId: string = event.user ?? ""

  // ── ask-antonio answer routing ──
  // If a running code-task session is waiting on a question in THIS thread,
  // Antonio's reply IS the answer: record it and SUPPRESS normal bot processing
  // so Claude doesn't also try to respond to it. Strictly scoped — fires only
  // when (a) the message is a thread reply, (b) the sender is Antonio, and (c) a
  // pending code_task_questions row exists for this thread. Fully defensive: any
  // error (including the table not yet existing in this environment) falls
  // through to normal processing, so this can never break the webhook nor
  // swallow a message unless a genuine pending question is present.
  if (threadTs && userId === ANTONIO_SLACK_USER_ID) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: pendingQ } = await (supabaseAdmin as any)
        .from("code_task_questions")
        .select("id")
        .eq("slack_thread_ts", threadTs)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1)
      if (pendingQ?.length) {
        const answer = text.replace(/<@[A-Z0-9]+>/g, "").trim()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabaseAdmin as any)
          .from("code_task_questions")
          .update({
            status: "answered",
            answer,
            answered_by: userId,
            answered_at: new Date().toISOString(),
          })
          .eq("id", pendingQ[0].id)
          .eq("status", "pending")
        return NextResponse.json({ ok: true, answered: pendingQ[0].id })
      }
    } catch (err) {
      console.warn("[slack-claude-webhook] ask-antonio answer routing skipped (non-fatal):", err)
    }
  }

  // Image attachments (Feature 2). Keep only Anthropic-supported image types
  // within the size cap; url_private is fetched later (with the bot token) by
  // the worker, NOT here — downloading during the ACK window risks the 3s SLA.
  const slackImages = ((event.files ?? []) as Array<Record<string, unknown>>)
    .filter((f) => typeof f?.mimetype === "string" && SLACK_SUPPORTED_IMAGE_TYPES.has(f.mimetype))
    .filter((f) => typeof f?.size !== "number" || (f.size as number) <= SLACK_MAX_IMAGE_BYTES)
    .map((f) => ({
      url: f.url_private as string,
      name: f.name as string | undefined,
      mimetype: f.mimetype as string,
      size: typeof f.size === "number" ? (f.size as number) : undefined,
    }))
    .filter((f) => typeof f.url === "string" && f.url.length > 0)

  // Proceed if there's text OR at least one usable image — an image-only
  // message (a screenshot dropped with no caption) must not be dropped here.
  if (!channelId || !eventTs || (!text && slackImages.length === 0)) {
    return NextResponse.json({ ok: true })
  }

  // Thread-reply invitation gate. A `message` event in a thread (never an
  // app_mention — this block is `!isAppMention`) is only processed if Claude was
  // actually invited to THIS thread. Three cases, in order:
  //   1. The reply itself @mentions Claude               → respond (explicit).
  //   2. The reply @mentions someone else but NOT Claude → skip (directed at
  //      other, e.g. "@Hermes do X" inside a thread Claude is part of).
  //   3. The reply has no @mention at all               → respond only if the
  //      thread's PARENT (root) message @mentioned Claude; otherwise the thread
  //      belongs to someone else (e.g. a Hermes-only thread) → skip silently.
  // Case 3 is the bug fix: the old guard checked a channel-level participation
  // row, so a plain reply in ANY thread of a channel where Claude had ever spoken
  // matched and Claude barged in. The parent-mention check scopes "invited" to
  // the actual thread. A top-level @mention always works (handled as app_mention
  // upstream); a top-level mention that opens a thread roots that thread at the
  // mention message, so its replies see parent-mention = true and continue.
  if (isThreadReply && !isAppMention) {
    const mentions: string[] = text.match(/<@U[A-Z0-9]+>/g) ?? []
    const replyMentionsClaude = mentions.includes(`<@${CLAUDE_BOT_USER_ID}>`)

    if (!replyMentionsClaude) {
      if (mentions.length > 0) {
        // Case 2 — aimed at another user/bot, not Claude.
        return NextResponse.json({ ok: true, skipped: "directed_at_other" })
      }
      // Case 3 — no @mention: only continue a thread Claude was invited into.
      if (!threadTs || !(await parentMessageMentionsClaude(channelId, threadTs))) {
        return NextResponse.json({ ok: true, skipped: "not_invited" })
      }
    }
  }

  // Idempotency: skip duplicate Slack event deliveries
  if (eventId && await isDuplicateEvent(eventId)) {
    return NextResponse.json({ ok: true })
  }

  // Dedup by message timestamp (catches app_mention + message for the same Slack
  // message). When Antonio @mentions Claude in a thread Claude already joined,
  // Slack fires TWO events — app_mention AND message — with DIFFERENT event_ids
  // but the SAME message ts. The event_id dedup above misses that; this catches
  // it because both events carry the same event.ts for the one underlying message.
  const msgTs = eventTs || event.event_ts
  if (msgTs) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: dupByTs } = await (supabaseAdmin as any)
      .from("agent_messages")
      .select("id")
      .eq("recipient", "claude")
      .filter("context_json->>slack_event_ts", "eq", msgTs)
      .filter("context_json->>slack_channel_id", "eq", channelId)
      .limit(1)
    if (dupByTs?.length) {
      return NextResponse.json({ ok: true, dedup: "message_ts" })
    }
  }

  // Immediate acknowledgment — Antonio sees this within 1-2s
  // Reply anchored to the message's ts so it opens (or continues) a thread.
  // Capture the ack message ts so the worker can morph it (chat.update) into
  // the real answer instead of posting a second message.
  const ackThreadTs = threadTs ?? eventTs
  const ackText = "On it 👍"
  // Attach a "⏹ Stop" button so Antonio can cancel before the worker posts its
  // answer (handled by /api/webhooks/slack-interactions). The button is dropped
  // when the worker morphs this message into the final answer.
  const ackTs = await postSlackMessage(
    channelId,
    ackText,
    ackThreadTs,
    buildThinkingBlocks(ackText),
  ).catch((err) => {
    console.error("[slack-claude-webhook] ACK post failed:", err)
    return null
  })

  // Scope → thread_id mapping for conversation continuity
  const scopeKey = slackScopeKey(channelId, threadTs)
  let threadId: string | null = null
  try {
    threadId = await findOrCreateConversationThread(channelId, threadTs)
  } catch (err) {
    console.error("[slack-claude-webhook] thread lookup failed:", err)
  }

  // Strip bot mention tokens from the message body so the worker sees clean text
  const cleanText = text.replace(/<@[A-Z0-9]+>/g, "").trim()
  // Image-only message (no caption): give the worker a non-empty text turn so
  // the model knows to look at the attached image(s).
  const body = cleanText || text || (slackImages.length > 0 ? "(image attached — no caption)" : "")

  // Referenced messages: a SHARED message (Slack "Share message" → attachment
  // carrying source channel + ts) or a pasted archive link in the text. Pure
  // extraction, no Slack API call — safe inside the 3s ACK window. The worker
  // resolves these into the source thread's content (so "@Claude read this" with
  // a shared message actually works). [] when none.
  const slackReferenced = collectSlackReferences({ text, attachments: event.attachments })

  // TEMPORARY DIAGNOSTIC (2026-06-19): confirm the share-attachment shape on the
  // first real "Share message" → @Claude. Logs only attachment KEYS (not text)
  // plus how many references we extracted. Remove once the share path is verified.
  if (Array.isArray(event.attachments) && event.attachments.length > 0) {
    console.warn(
      "[slack-claude-webhook] attachment shape:",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      JSON.stringify(event.attachments.map((a: any) => Object.keys(a ?? {}))),
      "→ refs extracted:",
      slackReferenced.length,
    )
  }

  // INSERT agent_messages row
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inserted, error: insertError } = await (supabaseAdmin as any)
    .from("agent_messages")
    .insert({
      sender: "slack",
      recipient: "claude",
      subject: `Slack mention in ${channelId}`,
      body,
      status: "pending",
      thread_id: threadId,
      context_json: {
        source: "slack",
        slack_event_id: eventId,
        slack_channel_id: channelId,
        slack_thread_ts: threadTs,
        slack_event_ts: eventTs,
        slack_scope_key: scopeKey,
        slack_user_id: userId,
        slack_ack_ts: ackTs, // null if the ack post failed → worker posts fresh
        slack_images: slackImages, // [] when no usable images
        slack_referenced: slackReferenced, // [] when no shared/linked messages
      },
    })
    .select("id")
    .single()

  if (insertError || !inserted?.id) {
    console.error("[slack-claude-webhook] INSERT failed:", insertError)
    return NextResponse.json({ ok: true }) // still ACK Slack
  }

  // Fire direct trigger — bounded await so the trigger leaves before we return
  await fireWorkerTrigger(inserted.id)

  return NextResponse.json({ ok: true })
}
