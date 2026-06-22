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
import { createClientConversationFromModal } from "@/lib/ai-agent/slack-claude"

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

  let body: { channelId?: string; userId?: string | null; clientValue?: string; topicSlug?: string }
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
    return NextResponse.json({ ok: false, error: res.error }, { status: 200 })
  }
  return NextResponse.json({ ok: true, threadTs: res.threadTs })
}
