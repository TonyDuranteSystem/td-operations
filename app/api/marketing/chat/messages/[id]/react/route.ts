import { NextRequest, NextResponse } from "next/server"
import { requireMarketing } from "@/lib/marketing/guard"
import { NO_STORE, toggleReaction } from "@/lib/marketing/lead-chat-server"

/** POST /api/marketing/chat/messages/[id]/react { emoji } — toggle my reaction. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireMarketing("chat")
  if (g.res) return g.res
  const { id } = await params
  const body = (await req.json().catch(() => ({}))) as { emoji?: unknown }
  const r = await toggleReaction(g.ctx, id, body.emoji)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ reactions: r.reactions }, { headers: NO_STORE })
}
