/**
 * Background handler for the 🗂️ card lifecycle buttons: Close, Reopen, Remove.
 *
 * The slack-interactions webhook ACKs Slack instantly (3s window) and fires this,
 * which does the slower work (close/reopen/remove + redraw the card). Same decoupling
 * as /api/cron/client-thread-create and /client-thread-follow.
 *
 * Auth: CRON_SECRET Bearer. Public /api/cron/* path.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { handleCardAction } from "@/lib/ai-agent/client-thread-follows"

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

  let body: { action?: string; channelId?: string; messageTs?: string; userId?: string | null }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 })
  }

  const { action, channelId, messageTs } = body
  if (!channelId || !messageTs || (action !== "close" && action !== "reopen" && action !== "remove")) {
    return NextResponse.json({ error: "missing/invalid action/channelId/messageTs" }, { status: 400 })
  }

  await handleCardAction({ action, channelId, messageTs, userId: body.userId ?? null })
  return NextResponse.json({ ok: true })
}
