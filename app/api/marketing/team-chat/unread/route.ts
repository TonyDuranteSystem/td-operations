import { NextResponse } from "next/server"
import { NO_STORE, requireTeamChat, unreadByThread } from "@/lib/marketing/team-chat-server"

/** GET /api/marketing/team-chat/unread — my unread messages in the team conversations: the total and the number per conversation. */
export async function GET() {
  const g = await requireTeamChat()
  if (g.res) return g.res
  const by = await unreadByThread(g.ctx)
  return NextResponse.json({ total: Array.from(by.values()).reduce((a, b) => a + b, 0), by_thread: Object.fromEntries(by) }, { headers: NO_STORE })
}
