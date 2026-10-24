import { NextRequest, NextResponse } from "next/server"
import { NO_STORE, loadChat, openChat } from "@/lib/marketing/lead-chat-server"

/** GET /api/marketing/chat/[leadId] — one lead's chat. `?mark_read=0` (the screen is in the background) reads without marking read. The team comes from the guard. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params
  const g = await openChat(leadId)
  if (g.res) return g.res
  const markRead = req.nextUrl.searchParams.get("mark_read") !== "0"
  return NextResponse.json(await loadChat(g.ctx, g.lead.id, markRead), { headers: NO_STORE })
}
