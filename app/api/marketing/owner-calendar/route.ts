import { NextRequest, NextResponse } from "next/server"
import { requireMarketing } from "@/lib/marketing/guard"
import { googleApi } from "@/lib/marketing/gcal"
import { addOwnerEvent } from "@/lib/marketing/owner-calendar-server"
import { getMarketingSetting } from "@/lib/marketing/settings"

export const dynamic = "force-dynamic"
const NO_STORE = { "Cache-Control": "no-store" }

/**
 * POST /api/marketing/owner-calendar — body { title, startIso, endIso }. Antonio adds an event to HIS OWN Google calendar from the Calendar (TD Marketing, dev job 9aec66fa, Addendum K, B3).
 * Antonio only, on his own login (not while "viewing as" somebody). There is no delete route on purpose.
 */
export async function POST(req: NextRequest) {
  const g = await requireMarketing()
  if (g.res) return g.res
  if (g.ctx.admin !== true || g.ctx.viewAs) return NextResponse.json({ error: "Only Antonio can change his own calendar, on his own login." }, { status: 403, headers: NO_STORE })
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return NextResponse.json({ error: "Send JSON." }, { status: 415, headers: NO_STORE })
  const body = (await req.json().catch(() => ({}))) as { title?: unknown; startIso?: unknown; endIso?: unknown }
  const owner = (await getMarketingSetting("owner_clock", g.ctx.team.id)) as { zone: string }
  const r = await addOwnerEvent(googleApi, g.ctx.user.email, owner.zone, body)
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: r.status, headers: NO_STORE })
  return NextResponse.json({ ok: true, id: r.data.id }, { headers: NO_STORE })
}
