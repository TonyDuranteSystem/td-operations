import { NextResponse } from "next/server"
import { NO_STORE, markLeadRead, openChat } from "@/lib/marketing/lead-chat-server"

/** POST /api/marketing/chat/[leadId]/read — I have read this chat (the screen calls it only while somebody is looking). */
export async function POST(req: Request, { params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params
  const g = await openChat(leadId, new URL(req.url).searchParams.get("lane"))
  if (g.res) return g.res
  await markLeadRead(g.ctx, g.lead.id, g.lane)
  return NextResponse.json({ ok: true }, { headers: NO_STORE })
}
