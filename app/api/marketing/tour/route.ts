import { NextRequest, NextResponse } from "next/server"
import { requireMarketing } from "@/lib/marketing/guard"
import { markTourSeen } from "@/lib/marketing/tour-seen"

const NO_STORE = { "Cache-Control": "no-store" }

/**
 * POST /api/marketing/tour — body { tour: 'setter' | …, status: 'done' | 'skipped' }. A person records that HE finished or skipped his own tour (the guard decides who he is).
 * Antonio looking in with "View as" records nothing: he is not that person.
 */
export async function POST(req: NextRequest) {
  const g = await requireMarketing()
  if (g.res) return g.res
  if (g.ctx.viewAs) return NextResponse.json({ ok: true, recorded: false }, { headers: NO_STORE })
  const body = await req.json().catch(() => ({}))
  const r = await markTourSeen({ userId: g.ctx.user.id, teamId: g.ctx.team.id, key: body.tour, status: body.status })
  if (r.ok === false) return NextResponse.json({ error: r.error }, { status: 400, headers: NO_STORE })
  return NextResponse.json({ ok: true, recorded: true }, { headers: NO_STORE })
}
