import { NextRequest, NextResponse } from "next/server"
import { NO_STORE, requireTeamChat, toggleThreadReaction } from "@/lib/marketing/team-chat-server"

/** POST /api/marketing/team-chat/messages/[id]/react { emoji } — toggle my reaction. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireTeamChat()
  if (g.res) return g.res
  const { id } = await params
  const body = (await req.json().catch(() => ({}))) as { emoji?: unknown }
  const r = await toggleThreadReaction(g.ctx, id, body.emoji)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ reactions: r.reactions }, { headers: NO_STORE })
}
