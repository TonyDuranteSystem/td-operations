/**
 * Background creator for the Slack client-conversation form.
 *
 * Why this exists: Slack gives a view_submission only ~3 seconds to respond. The
 * actual create work (chat.postMessage to post the labeled root + the client_threads
 * insert) is fine when warm but can exceed 3s on a cold start, which makes Slack show
 * "We had some trouble connecting" even though the thread was created. To avoid that,
 * the slack-interactions webhook responds to the modal instantly and fires a
 * fire-and-forget request here to do the slow part — the same decoupling the
 * @Claude events path uses (fireWorkerTrigger → /api/cron/slack-claude-worker).
 *
 * Auth: CRON_SECRET Bearer (same key the slack webhooks use). Public path
 * (/api/cron/* is auth-exempt in middleware and NOT blocked by SANDBOX_MODE).
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { createClientConversationFromModal, slackApiCall } from "@/lib/ai-agent/slack-claude"
import { refreshOpenConversationsCanvas } from "@/lib/ai-agent/client-thread-follows"

function isAuthorized(req: NextRequest): boolean {
  const authHeader = req.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) return authHeader === null || authHeader === "Bearer "
  return authHeader === `Bearer ${cronSecret}`
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  let body: {
    channelId?: string
    notifyChannel?: string
    userId?: string | null
    clientValue?: string
    topicSlug?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 })
  }

  const { channelId, clientValue, topicSlug } = body
  if (!channelId || !clientValue || !topicSlug) {
    return NextResponse.json({ error: "missing channelId/clientValue/topicSlug" }, { status: 400 })
  }

  const res = await createClientConversationFromModal({
    channelId,
    userId: body.userId ?? null,
    clientValue,
    topicSlug,
  })

  if (!res.ok) {
    console.error("[client-thread-create] create failed:", res.error)
    // Tell the user (in a channel where the bot can reach them) instead of failing
    // silently — most common cause is the bot not being a member of the picked channel.
    const notify = body.notifyChannel || channelId
    if (body.userId) {
      await slackApiCall("chat.postEphemeral", {
        channel: notify,
        user: body.userId,
        text: `Couldn't start the conversation in <#${channelId}> — make sure I'm a member there (invite me with \`/invite @Claude\`), then try again. Nothing was created.`,
      }).catch(() => {})
    }
    return NextResponse.json({ ok: false, error: res.error }, { status: 200 })
  }
  // New open conversation → reflect it on the shared Canvas. If it fails (e.g. the
  // canvases:write scope isn't active after reinstall), surface the exact Slack error
  // to the creator instead of failing silently — the conversation itself is fine.
  const canvas = await refreshOpenConversationsCanvas()
  if (!canvas.ok && body.userId) {
    await slackApiCall("chat.postEphemeral", {
      channel: body.notifyChannel || channelId,
      user: body.userId,
      text: `(Note: the shared Canvas didn't update — Slack said: \`${canvas.error}\`. The conversation was created fine; this only affects the Canvas board.)`,
    }).catch(() => {})
  }
  return NextResponse.json({ ok: true, threadTs: res.threadTs })
}
