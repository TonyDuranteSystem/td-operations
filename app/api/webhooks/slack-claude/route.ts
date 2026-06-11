/**
 * Slack Events API webhook — Claude bot (app A0B9LUJRLMB)
 *
 * Receives app_mention events from Slack, immediately posts "On it 👍" so
 * Antonio has instant acknowledgment (< 2s), then queues the message for
 * the Slack worker cron to process with the full Claude AI response.
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
  findOrCreateConversationThread,
  slackScopeKey,
} from "@/lib/ai-agent/slack-claude"
import { getInternalBaseUrl } from "@/lib/mcp/tools/agent-messages"

// Claude bot user ID — used to filter out self-messages (loop protection)
const CLAUDE_BOT_USER_ID = "U0B9S675WTT"

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

  // Only process app_mention events
  if (event.type !== "app_mention") {
    return NextResponse.json({ ok: true })
  }

  // Loop protection: skip messages from bots (including ourselves)
  if (event.bot_id || event.user === CLAUDE_BOT_USER_ID || event.subtype === "bot_message") {
    return NextResponse.json({ ok: true })
  }

  const channelId: string = event.channel ?? ""
  const threadTs: string | null = event.thread_ts ?? null  // set when message is in a thread
  const eventTs: string = event.ts ?? ""
  const text: string = event.text ?? ""
  const userId: string = event.user ?? ""

  if (!channelId || !eventTs || !text) {
    return NextResponse.json({ ok: true })
  }

  // Idempotency: skip duplicate Slack event deliveries
  if (eventId && await isDuplicateEvent(eventId)) {
    return NextResponse.json({ ok: true })
  }

  // Immediate acknowledgment — Antonio sees this within 1-2s
  // Reply anchored to the message's ts so it opens (or continues) a thread
  const ackThreadTs = threadTs ?? eventTs
  await postSlackMessage(channelId, "On it 👍", ackThreadTs).catch((err) => {
    console.error("[slack-claude-webhook] ACK post failed:", err)
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

  // INSERT agent_messages row
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inserted, error: insertError } = await (supabaseAdmin as any)
    .from("agent_messages")
    .insert({
      sender: "slack",
      recipient: "claude",
      subject: `Slack mention in ${channelId}`,
      body: cleanText || text,
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
