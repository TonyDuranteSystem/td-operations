import { NextRequest, NextResponse } from "next/server"
import { resolveMarketingContext } from "@/lib/marketing/guard"
import { getMarketingSetting, setMarketingSetting } from "@/lib/marketing/settings"
import { memberZone } from "@/lib/marketing/time-prefs"
import { zoneToStore } from "@/lib/marketing/zone-report"

export const dynamic = "force-dynamic"
const NO_STORE = { "Cache-Control": "no-store" }

/**
 * POST /api/marketing/my-zone — body { zone }. The person at the keyboard says which time zone their browser is in (Antonio, 31 Oct 2026: the times must follow where we connect). It only ever
 * changes THE CALLER's own zone: Antonio (own login or "View as": he is the one at the keyboard) changes the owner's clock, anybody else changes their own row in the team's zones. A zone that
 * is not a real place (a browser that hides it reports UTC) or is the same as the stored one changes nothing. Every change is kept in the settings history.
 */
export async function POST(req: NextRequest) {
  const g = await resolveMarketingContext()
  if (g.ok === false) return NextResponse.json({ error: "Not allowed." }, { status: 403, headers: NO_STORE })
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) return NextResponse.json({ error: "Send JSON." }, { status: 415, headers: NO_STORE })
  const body = await req.json().catch(() => ({})) as { zone?: unknown }
  const { ctx } = g
  const teamId = ctx.team.id
  const actor = ctx.user.email ?? ctx.user.id
  if (ctx.admin === true) {
    const cur = (await getMarketingSetting("owner_clock", teamId)) as { zone: string; label: string; email?: string }
    const z = zoneToStore(body.zone, cur.zone)
    if (!z) return NextResponse.json({ ok: true, changed: false }, { headers: NO_STORE })
    const r = await setMarketingSetting({ key: "owner_clock", value: { ...cur, zone: z }, teamId, actor })
    if (r.ok === false) return NextResponse.json({ error: r.error }, { status: 400, headers: NO_STORE })
    return NextResponse.json({ ok: true, changed: true, zone: z }, { headers: NO_STORE })
  }
  const cur = (await getMarketingSetting("member_time_zones", teamId)) as Record<string, string>
  const z = zoneToStore(body.zone, memberZone({ memberZones: cur }, ctx.user.id))
  if (!z) return NextResponse.json({ ok: true, changed: false }, { headers: NO_STORE })
  const r = await setMarketingSetting({ key: "member_time_zones", value: { ...cur, [ctx.user.id]: z }, teamId, actor })
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: 400, headers: NO_STORE })
  return NextResponse.json({ ok: true, changed: true, zone: z }, { headers: NO_STORE })
}
