/**
 * Drive → storage catch-up for a switched company (owners only; dev job ad09ea91).
 *   GET  ?list=1                  — every company with something to catch up (reads only)
 *   GET  ?account=<id>            — DRY RUN for one company: what would be brought in, what is left and why (reads only)
 *   POST { accountId, planHash }  — bring in ONE company's records (planHash = the preview's value; a changed company refuses)
 *   POST { undoRunId }            — put every record of a catch-up back on its Drive file (the company stays switched)
 *   POST { sweep: true }          — close a catch-up that stopped answering
 * Writes need STORE_GO_LIVE=1 in this environment (default OFF).
 */
export const dynamic = "force-dynamic"
export const maxDuration = 300

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isOwnerOnly } from "@/lib/auth"

async function owner() {
  const { data: { user } } = await createClient().auth.getUser()
  return user && isOwnerOnly(user) ? user : null
}

export async function GET(req: NextRequest) {
  if (!(await owner())) return NextResponse.json({ error: "Owners only." }, { status: 403 })
  try {
    if (req.nextUrl.searchParams.get("list")) {
      const { listCatchUp } = await import("@/lib/crm-store/catch-up")
      const list = await listCatchUp()
      return NextResponse.json({ companies: list, records: list.reduce((n, c) => n + c.eligible, 0) }, { headers: { "Cache-Control": "no-store" } })
    }
    const accountId = req.nextUrl.searchParams.get("account")
    if (!accountId) return NextResponse.json({ error: "account or list is required" }, { status: 400 })
    const { planCatchUp } = await import("@/lib/crm-store/catch-up")
    return NextResponse.json(await planCatchUp(accountId), { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not check this company." }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const user = await owner()
  if (!user) return NextResponse.json({ error: "Owners only." }, { status: 403 })
  const { goLiveAllowed } = await import("@/lib/crm-store/go-live")
  if (!goLiveAllowed()) return NextResponse.json({ error: "Catch-up is switched off in this environment." }, { status: 403 })
  const body = (await req.json().catch(() => ({}))) as { accountId?: string; planHash?: string; undoRunId?: string; sweep?: boolean }
  try {
    if (body.undoRunId) {
      const { undoCatchUp } = await import("@/lib/crm-store/catch-up")
      return NextResponse.json(await undoCatchUp(body.undoRunId, user.id))
    }
    if (body.sweep) {
      const { sweepStaleCatchUpRuns } = await import("@/lib/crm-store/catch-up")
      return NextResponse.json(await sweepStaleCatchUpRuns())
    }
    if (!body.accountId) return NextResponse.json({ error: "accountId is required" }, { status: 400 })
    const { runCatchUp } = await import("@/lib/crm-store/catch-up")
    return NextResponse.json(await runCatchUp(body.accountId, user.id, { expectedPlanHash: body.planHash }))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The catch-up failed." }, { status: 500 })
  }
}
