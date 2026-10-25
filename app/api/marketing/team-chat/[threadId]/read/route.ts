import { NextResponse } from "next/server"
import { NO_STORE, markThreadRead, openThread } from "@/lib/marketing/team-chat-server"

/** POST /api/marketing/team-chat/[threadId]/read — I have read this conversation (the screen calls it only while somebody is looking). */
export async function POST(_req: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params
  const g = await openThread(threadId)
  if (g.res) return g.res
  await markThreadRead(g.ctx, g.thread.id)
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}
