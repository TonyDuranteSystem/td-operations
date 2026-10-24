import { NextRequest, NextResponse } from "next/server"
import { NO_STORE, openThread, sendThreadMessage } from "@/lib/marketing/team-chat-server"

/** POST /api/marketing/team-chat/[threadId]/messages { message, reply_to_id?, attachments? } — send. Files must already be in this conversation's own folder (see upload-url). People named with @ are told. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params
  const g = await openThread(threadId)
  if (g.res) return g.res
  const body = (await req.json().catch(() => ({}))) as { message?: unknown; attachments?: unknown; reply_to_id?: unknown }
  const r = await sendThreadMessage(g.ctx, { thread: g.thread, memberIds: g.memberIds }, body)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ message: r.message }, { headers: NO_STORE })
}
