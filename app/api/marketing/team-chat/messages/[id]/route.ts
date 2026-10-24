import { NextRequest, NextResponse } from "next/server"
import { NO_STORE, deleteThreadMessage, editThreadMessage, requireTeamChat } from "@/lib/marketing/team-chat-server"

/** PATCH /api/marketing/team-chat/messages/[id] { message } — edit my own message. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireTeamChat()
  if (g.res) return g.res
  const { id } = await params
  const body = (await req.json().catch(() => ({}))) as { message?: unknown }
  const r = await editThreadMessage(g.ctx, id, body.message)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ message: r.message }, { headers: NO_STORE })
}

/** DELETE /api/marketing/team-chat/messages/[id] — soft delete (the message leaves a note, the row stays for the record). The author or the team owner. */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireTeamChat()
  if (g.res) return g.res
  const { id } = await params
  const r = await deleteThreadMessage(g.ctx, id)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}
