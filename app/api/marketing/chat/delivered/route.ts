import { NextRequest, NextResponse } from "next/server"
import { NO_STORE, requireChatAccess, markDelivered } from "@/lib/marketing/lead-chat-server"

/** POST /api/marketing/chat/delivered { items: [{ lead_id }] } — this device has these chats (the grey double tick). Only leads of the guard's team count. */
export async function POST(req: NextRequest) {
  const g = await requireChatAccess()
  if (g.res) return g.res
  const body = (await req.json().catch(() => ({}))) as { items?: Array<{ lead_id?: unknown; lane?: unknown }> }
  const items = Array.isArray(body.items) ? body.items.filter((i): i is { lead_id: string; lane?: unknown } => typeof i?.lead_id === "string") : []
  return NextResponse.json({ ok: true, marked: await markDelivered(g.ctx, items) }, { headers: NO_STORE })
}
