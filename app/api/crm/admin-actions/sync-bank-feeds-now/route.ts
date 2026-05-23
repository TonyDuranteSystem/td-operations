/**
 * POST /api/crm/admin-actions/sync-bank-feeds-now
 *
 * Admin-only endpoint that runs the full sync + match + activate chain on
 * demand. Same chain the 15-min crons run; surfaced as a button on
 * Finance → Bank Feed for staff who don't want to wait for the next cron tick.
 *
 * Providers: Mercury, Airwallex, Stripe, Plaid (covers Relay + any other
 * active Plaid connections except Mercury which has its own direct sync above).
 *
 * Each sub-step is wrapped so a failure in one provider (e.g. Mercury outage)
 * does not prevent the others from running. The match step always runs — it's
 * idempotent and will pick up any pre-existing unmatched feeds from prior runs.
 */

export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isDashboardUser } from "@/lib/auth"
import { syncMercuryTransactions } from "@/lib/mercury-sync"
import { syncAirwallexDeposits } from "@/lib/airwallex-sync"
import { syncStripeCharges } from "@/lib/stripe-sync"
import { syncPlaidTransactions } from "@/lib/plaid-sync"
import { processBankFeedMatches } from "@/lib/operations/process-bank-feed-matches"

type MercuryResult = Awaited<ReturnType<typeof syncMercuryTransactions>>
type AirwallexResult = Awaited<ReturnType<typeof syncAirwallexDeposits>>
type StripeResult = Awaited<ReturnType<typeof syncStripeCharges>>
type PlaidConnectionResult = { bank: string; added: number; modified: number } | { bank: string; error: string }
type PlaidResult = { connections: number; results: PlaidConnectionResult[] } | { error: string }
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

  let stripe: StepResult<StripeResult> = { error: "not_run" }
  try {
    stripe = await syncStripeCharges({ daysBack })
  } catch (err) {
    stripe = { error: err instanceof Error ? err.message : String(err) }
  }

  let plaid: PlaidResult = { error: "not_run" }
  try {
    const { data: connections } = await supabaseAdmin
      .from('plaid_connections')
      .select('id, access_token, bank_name')
      .eq('status', 'active')
      .neq('bank_name', 'mercury')
    if (!connections || connections.length === 0) {
      plaid = { connections: 0, results: [] }
    } else {
      const results: PlaidConnectionResult[] = []
      for (const conn of connections) {
        try {
          const r = await syncPlaidTransactions(conn.access_token, conn.bank_name)
          results.push({ bank: conn.bank_name, added: r.added, modified: r.modified })
        } catch (err) {
          results.push({ bank: conn.bank_name, error: err instanceof Error ? err.message : String(err) })
        }
      }
      plaid = { connections: connections.length, results }
    }
  } catch (err) {
    plaid = { error: err instanceof Error ? err.message : String(err) }
  }

  let match: StepResult<MatchResult> = { error: "not_run" }
  try {
    match = await processBankFeedMatches()
  } catch (err) {
    match = { error: err instanceof Error ? err.message : String(err) }
  }

  return NextResponse.json({ ok: true, from, to, mercury, airwallex, stripe, plaid, match })
}
