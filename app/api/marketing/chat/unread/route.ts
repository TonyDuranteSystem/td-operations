import { NextResponse } from "next/server"
import { NO_STORE, requireChatAccess, unreadByLane, unreadByLead } from "@/lib/marketing/lead-chat-server"

/** GET /api/marketing/chat/unread — my unread chat messages: the total and the number per lead. */
export async function GET() {
  const g = await requireChatAccess()
  if (g.res) return g.res
  const [by, lanes] = await Promise.all([unreadByLead(g.ctx), unreadByLane(g.ctx)])
  return NextResponse.json({ total: Array.from(by.values()).reduce((a, b) => a + b, 0), by_lead: Object.fromEntries(by), by_lane: Object.fromEntries(Array.from(lanes).map(([key, u]) => [key, u.n])) }, { headers: NO_STORE })
}
