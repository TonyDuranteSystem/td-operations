/**
 * Slack slash command webhook — Claude bot (app A0B9LUJRLMB)
 *
 * Handles /client → opens the client-conversation modal (same form as the button +
 * global shortcut). Slack sends slash commands as application/x-www-form-urlencoded
 * (command, text, trigger_id, channel_id, user_id, …) — NOT the `payload` JSON the
 * interactivity webhook gets. Signature verification is identical (HMAC-SHA256,
 * SLACK_SIGNING_SECRET_CLAUDE).
 *
 * Setup: Slack app → "Slash Commands" → Create New Command → /client → Request URL
 * = this route. Then reinstall the app. See slack-claude-worker.md.
 *
 * Public path (/api/webhooks/*) — auth-exempt in middleware, blocked in sandbox by
 * SANDBOX_MODE. Production-only.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { verifySlackSignature, openClientConversationModal } from "@/lib/ai-agent/slack-claude"

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text()
  const timestamp = req.headers.get("x-slack-request-timestamp") ?? ""
  const signature = req.headers.get("x-slack-signature") ?? ""

  if (!verifySlackSignature(rawBody, timestamp, signature, process.env.SLACK_SIGNING_SECRET_CLAUDE)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  const params = new URLSearchParams(rawBody)
  const command = params.get("command")
  const triggerId = params.get("trigger_id")
  // Open the conversation in the channel where the command was typed; fall back to
  // the configured support channel (e.g. when run from a DM).
  const channelId = params.get("channel_id") || process.env.SLACK_SUPPORT_CHANNEL_ID || ""

  if (command === "/client" && triggerId && channelId) {
    await openClientConversationModal(triggerId, channelId)
    // Empty 200 = no visible command echo; the modal opens.
    return new NextResponse("", { status: 200 })
  }

  // Unknown command / missing trigger — acknowledge so Slack shows no error.
  return new NextResponse("", { status: 200 })
}
