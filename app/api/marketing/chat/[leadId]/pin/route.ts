import { NextResponse } from "next/server"
import { NO_STORE, openChat, setLeadMessagePinned } from "@/lib/marketing/lead-chat-server"

/** POST /api/marketing/chat/[leadId]/pin { message_id, pinned } — pin (true) or unpin (false) a message for everyone who can see it. */
export async function POST(req: Request, { params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params
  const g = await openChat(leadId)
  if (g.res) return g.res
  const body = (await req.json().catch(() => ({}))) as { message_id?: unknown; pinned?: unknown }
  const r = await setLeadMessagePinned(g.ctx, g.lead.id, body.message_id, body.pinned !== false)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ ok: true, pinned_at: r.pinned_at }, { headers: NO_STORE })
}
