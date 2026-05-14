/**
 * POST /api/crm/admin-actions/sync-bank-feeds-now
 *
 * Admin-only endpoint that runs the full sync + match + activate chain on
 * demand. Same chain the 15-min crons run; surfaced as a button on
 * Finance → Bank Feed for staff who don't want to wait for the next cron tick.
 *
 * Each sub-step is wrapped so a failure in one provider (e.g. Mercury outage)
 * does not prevent the others from running. The match step always runs — it's
 * idempotent and will pick up any pre-existing unmatched feeds from prior runs.
 */

export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isDashboardUser } from "@/lib/auth"
import { syncMercuryTransactions } from "@/lib/mercury-sync"
import { syncAirwallexDeposits } from "@/lib/airwallex-sync"
import { processBankFeedMatches } from "@/lib/operations/process-bank-feed-matches"

type MercuryResult = Awaited<ReturnType<typeof syncMercuryTransactions>>
type AirwallexResult = Awaited<ReturnType<typeof syncAirwallexDeposits>>
type MatchResult = Awaited<ReturnType<typeof processBankFeedMatches>>
type StepResult<T> = T | { error: string }

export async function POST(_req: NextRequest) {
  // Require authenticated dashboard user.
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: "Dashboard access required" }, { status: 403 })
  }

  // 7-day window matches the 15-min cron (?days=7).
  const daysBack = 7
  const from = new Date(Date.now() - daysBack * 86400000).toISOString().split("T")[0]
  const to = new Date().toISOString().split("T")[0]

  let mercury: StepResult<MercuryResult> = { error: "not_run" }
  try {
    mercury = await syncMercuryTransactions(from, to)
  } catch (err) {
    mercury = { error: err instanceof Error ? err.message : String(err) }
  }

  let airwallex: StepResult<AirwallexResult> = { error: "not_run" }
  try {
    airwallex = await syncAirwallexDeposits(from, to)
  } catch (err) {
    airwallex = { error: err instanceof Error ? err.message : String(err) }
  }

  let match: StepResult<MatchResult> = { error: "not_run" }
  try {
    match = await processBankFeedMatches()
  } catch (err) {
    match = { error: err instanceof Error ? err.message : String(err) }
  }

  return NextResponse.json({ ok: true, from, to, mercury, airwallex, match })
}
