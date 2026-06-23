/**
 * Background handler for the "👀 Follow" button on a 🗂️ client-conversation message.
 *
 * The slack-interactions webhook ACKs Slack instantly (within the 3s window) and fires
 * this endpoint, which does the slower work: resolve the thread, toggle the follow,
 * post an ephemeral confirmation, and refresh the user's "📌 Following" DM list. Same
 * decoupling as /api/cron/client-thread-create.
 *
 * Auth: CRON_SECRET Bearer. Public path (/api/cron/* is auth-exempt; not blocked by
 * SANDBOX_MODE).
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { handleFollowToggle } from "@/lib/ai-agent/client-thread-follows"

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

  let body: { channelId?: string; messageTs?: string; userId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 })
  }

  const { channelId, messageTs, userId } = body
  if (!channelId || !messageTs || !userId) {
    return NextResponse.json({ error: "missing channelId/messageTs/userId" }, { status: 400 })
  }

  await handleFollowToggle({ channelId, messageTs, userId })
  return NextResponse.json({ ok: true })
}
