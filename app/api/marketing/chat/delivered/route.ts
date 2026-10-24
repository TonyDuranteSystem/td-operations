import { NextRequest, NextResponse } from "next/server"
import { requireMarketing } from "@/lib/marketing/guard"
import { NO_STORE, markDelivered } from "@/lib/marketing/lead-chat-server"

/** POST /api/marketing/chat/delivered { items: [{ lead_id }] } — this device has these chats (the grey double tick). Only leads of the guard's team count. */
export async function POST(req: NextRequest) {
  const g = await requireMarketing("chat")
  if (g.res) return g.res
  const body = (await req.json().catch(() => ({}))) as { items?: Array<{ lead_id?: unknown }> }
  const ids = Array.isArray(body.items) ? body.items.map(i => i?.lead_id).filter((x): x is string => typeof x === "string") : []
  return NextResponse.json({ ok: true, marked: await markDelivered(g.ctx, ids) }, { headers: NO_STORE })
}
