import { NextRequest, NextResponse } from "next/server"
import { NO_STORE, markThreadsDelivered, requireTeamChat } from "@/lib/marketing/team-chat-server"

/** POST /api/marketing/team-chat/delivered { items: [{ thread_id }] } — this device has these conversations (the grey double tick). Only conversations I am in count. */
export async function POST(req: NextRequest) {
  const g = await requireTeamChat()
  if (g.res) return g.res
  const body = (await req.json().catch(() => ({}))) as { items?: Array<{ thread_id?: unknown }> }
  const ids = Array.isArray(body.items) ? body.items.map(i => i?.thread_id).filter((x): x is string => typeof x === "string") : []
  return NextResponse.json({ ok: true, marked: await markThreadsDelivered(g.ctx, ids) }, { headers: NO_STORE })
}
