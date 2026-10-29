import { NextResponse } from "next/server"
import { NO_STORE, markLeadUnreadFrom, openChat } from "@/lib/marketing/lead-chat-server"

/** POST /api/marketing/chat/[leadId]/unread { message_id } — "Mark unread" from that message on, for me only (my read position moves back; nobody else's chat changes). */
export async function POST(req: Request, { params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params
  const g = await openChat(leadId)
  if (g.res) return g.res
  const body = (await req.json().catch(() => ({}))) as { message_id?: unknown }
  const r = await markLeadUnreadFrom(g.ctx, g.lead.id, body.message_id)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}
