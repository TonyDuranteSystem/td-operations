import { NextResponse } from "next/server"
import { NO_STORE, markThreadUnreadFrom, openThread } from "@/lib/marketing/team-chat-server"

/** POST /api/marketing/team-chat/[threadId]/unread { message_id } — "Mark unread" from that message on, for me only (my read position moves back; nobody else's chat changes). */
export async function POST(req: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params
  const g = await openThread(threadId)
  if (g.res) return g.res
  const body = (await req.json().catch(() => ({}))) as { message_id?: unknown }
  const r = await markThreadUnreadFrom(g.ctx, g.thread.id, body.message_id)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}
