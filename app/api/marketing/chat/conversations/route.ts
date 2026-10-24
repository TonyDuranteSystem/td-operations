import { NextResponse } from "next/server"
import { NO_STORE, requireChatAccess, listConversations } from "@/lib/marketing/lead-chat-server"

/** GET /api/marketing/chat/conversations — every lead of my team that has a chat: newest line, who wrote it, my unread number. */
export async function GET() {
  const g = await requireChatAccess()
  if (g.res) return g.res
  return NextResponse.json({ conversations: await listConversations(g.ctx) }, { headers: NO_STORE })
}
