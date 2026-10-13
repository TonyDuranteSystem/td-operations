/**
 * "Go live" — switch a company to the new storage (owners only; master plan Part 33, dev job ad09ea91).
 *   GET  ?account=<id>            — DRY RUN: what would happen (reads only)
 *   GET  ?night=1                 — how many companies are ready for the night run (reads only)
 *   POST { accountId }            — switch ONE company (checks everything; any difference undoes it)
 *   POST { undoRunId }            — undo a switch
 *   POST { night: true, limit? }  — switch the next group of companies, skipping and listing any that fail a check
 * Every write needs STORE_GO_LIVE=1 in this environment (default OFF).
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
    if (req.nextUrl.searchParams.get("night")) {
      const { nightCandidates } = await import("@/lib/crm-store/go-live-batch")
      const list = await nightCandidates()
      return NextResponse.json({ ready: list.length, companies: list.map((c) => c.companyName) }, { headers: { "Cache-Control": "no-store" } })
    }
    const accountId = req.nextUrl.searchParams.get("account")
    if (!accountId) return NextResponse.json({ error: "account is required" }, { status: 400 })
    const { planGoLive } = await import("@/lib/crm-store/go-live-run")
    return NextResponse.json(await planGoLive(accountId), { headers: { "Cache-Control": "no-store" } })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not check this company." }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const user = await owner()
  if (!user) return NextResponse.json({ error: "Owners only." }, { status: 403 })
  const { goLiveAllowed } = await import("@/lib/crm-store/go-live")
  if (!goLiveAllowed()) return NextResponse.json({ error: "Going live is switched off in this environment." }, { status: 403 })
  const body = (await req.json().catch(() => ({}))) as { accountId?: string; undoRunId?: string; night?: boolean; limit?: number }
  try {
    if (body.undoRunId) {
      const { undoGoLive } = await import("@/lib/crm-store/go-live-run")
      return NextResponse.json(await undoGoLive(body.undoRunId, user.id))
    }
    if (body.night) {
      const { runNightBatch } = await import("@/lib/crm-store/go-live-batch")
      return NextResponse.json(await runNightBatch(user.id, { limit: Math.min(Math.max(Number(body.limit) || 20, 1), 40) }))
    }
    if (!body.accountId) return NextResponse.json({ error: "accountId is required" }, { status: 400 })
    const { runGoLive } = await import("@/lib/crm-store/go-live-run")
    const r = await runGoLive(body.accountId, user.id)
    return NextResponse.json(r, { status: r.ok ? 200 : 409 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The switch could not run." }, { status: 400 })
  }
}
