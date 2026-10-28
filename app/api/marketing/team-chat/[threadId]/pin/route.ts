import { NextResponse } from "next/server"
import { NO_STORE, openThread, setThreadMessagePinned } from "@/lib/marketing/team-chat-server"

/** POST /api/marketing/team-chat/[threadId]/pin { message_id, pinned } — pin (true) or unpin (false) a message for everyone in the conversation. */
export async function POST(req: Request, { params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params
  const g = await openThread(threadId)
  if (g.res) return g.res
  const body = (await req.json().catch(() => ({}))) as { message_id?: unknown; pinned?: unknown }
  const r = await setThreadMessagePinned(g.ctx, g.thread.id, body.message_id, body.pinned !== false)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ ok: true, pinned_at: r.pinned_at }, { headers: NO_STORE })
}
