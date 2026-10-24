import { NextResponse } from "next/server"
import { requireMarketing } from "@/lib/marketing/guard"
import { NO_STORE, unreadByLead } from "@/lib/marketing/lead-chat-server"

/** GET /api/marketing/chat/unread — my unread chat messages: the total and the number per lead. */
export async function GET() {
  const g = await requireMarketing("chat")
  if (g.res) return g.res
  const by = await unreadByLead(g.ctx)
  return NextResponse.json({ total: Array.from(by.values()).reduce((a, b) => a + b, 0), by_lead: Object.fromEntries(by) }, { headers: NO_STORE })
}
