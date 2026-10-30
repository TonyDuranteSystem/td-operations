import { NextRequest, NextResponse } from "next/server"
import { requireMarketing } from "@/lib/marketing/guard"
import { googleApi } from "@/lib/marketing/gcal"
import { moveOwnerEvent } from "@/lib/marketing/owner-calendar-server"
import { getMarketingSetting } from "@/lib/marketing/settings"

export const dynamic = "force-dynamic"
const NO_STORE = { "Cache-Control": "no-store" }

/**
 * PATCH /api/marketing/owner-calendar/[id] — body { startIso, confirmGuests? }. Antonio moves one of HIS OWN Google events to another time (same length). An event with guests is refused with
 * the code GUESTS and the guests' names until he confirms (the server enforces it). There is no delete (TD Marketing, dev job 9aec66fa, Addendum K, B3).
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await requireMarketing()
  if (g.res) return g.res
  if (g.ctx.admin !== true || g.ctx.viewAs) return NextResponse.json({ error: "Only Antonio can change his own calendar, on his own login." }, { status: 403, headers: NO_STORE })
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return NextResponse.json({ error: "Send JSON." }, { status: 415, headers: NO_STORE })
  const body = (await req.json().catch(() => ({}))) as { startIso?: unknown; confirmGuests?: unknown }
  const { id } = await params
  const owner = (await getMarketingSetting("owner_clock", g.ctx.team.id)) as { zone: string }
  const r = await moveOwnerEvent(googleApi, g.ctx.user.email, owner.zone, id, body)
  if (r.ok === false) return NextResponse.json({ error: r.error, ...(r.code ? { code: r.code, guests: r.guests } : {}) }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ ok: true, id: r.data.id }, { headers: NO_STORE })
}
