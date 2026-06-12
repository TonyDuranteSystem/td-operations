/**
 * Slack interactive components webhook — Claude bot (app A0B9LUJRLMB)
 *
 * Handles button clicks from the "On it 👍" acknowledgment. The only action is
 * the "⏹ Stop" button (action_id = stop_thinking): it cancels the in-flight
 * agent_messages row so the Slack worker doesn't post its answer, and morphs the
 * Slack message into "⏹ Stopped — go ahead with your update".
 *
 * Slack delivers interactivity payloads as application/x-www-form-urlencoded
 * with a single `payload` JSON field. Signature verification is identical to the
 * events webhook (HMAC-SHA256, SLACK_SIGNING_SECRET_CLAUDE).
 *
 * Correlation: the clicked message's ts equals the ack ts stored on the row as
 * context_json.slack_ack_ts, so we find the row by (slack_ack_ts, channel). The
 * cancel is a conditional UPDATE guarded on status IN ('pending','processing') —
 * a Stop clicked AFTER the answer already posted (status='done') matches zero
 * rows and is a safe no-op that never erases the delivered answer.
 *
 * NOTE: only prevents the answer from being POSTED (and stops a not-yet-claimed
 * message from running). callWorker is a single non-interruptible API call, so
 * Claude may keep thinking server-side; we just don't post the result.
 *
 * Setup: in the Slack app's "Interactivity & Shortcuts", point the Request URL
 * at this route on the production deployment (see slack-claude-worker.md).
 *
 * Public path (/api/webhooks/*) — auth-exempt in middleware, blocked in sandbox
 * by SANDBOX_MODE. Production-only, like the rest of slack-claude.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  verifySlackSignature,
  parseSlackInteraction,
  updateSlackMessage,
  STOP_THINKING_ACTION_ID,
} from "@/lib/ai-agent/slack-claude"

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text()
  const timestamp = req.headers.get("x-slack-request-timestamp") ?? ""
  const signature = req.headers.get("x-slack-signature") ?? ""

  if (!verifySlackSignature(rawBody, timestamp, signature, process.env.SLACK_SIGNING_SECRET_CLAUDE)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  const interaction = parseSlackInteraction(rawBody)
  // ACK any unrelated/unknown interaction so Slack doesn't surface an error.
  if (!interaction || interaction.actionId !== STOP_THINKING_ACTION_ID) {
    return NextResponse.json({ ok: true })
  }

  const { messageTs, channelId } = interaction
  if (!messageTs || !channelId) {
    return NextResponse.json({ ok: true })
  }

  // Conditional cancel: only flip a row that's still pending/processing. The
  // clicked message's ts is the ack ts stored on the row (slack_ack_ts). A Stop
  // clicked after the worker already finished matches zero rows → no-op.
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

  // Only touch the Slack message if we actually stopped something — drop the
  // button (blocks: []) and show the stopped notice. If nothing was cancelled
  // (already done/failed), leave the message as-is so a delivered answer stays.
  if (cancelled?.length) {
    await updateSlackMessage(
      channelId,
      messageTs,
      "⏹ Stopped — go ahead with your update",
      [],
    ).catch((err) => {
      console.error("[slack-interactions] stop message update failed:", err)
      return false
    })
  }

  return NextResponse.json({ ok: true })
}
