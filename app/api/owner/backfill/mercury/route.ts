import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/auth'
import { NextResponse } from 'next/server'
import { syncMercuryTransactions } from '@/lib/mercury-sync'
import { sweepFeedsToOwnerLedger } from '@/lib/finance/owner-ledger-projection'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Mercury full-history backfill (Phase 2). Mercury's API accepts any date range, so
 * history is a parameter here, not a statement upload: pull the range into the bank
 * feed (idempotent — upsert by the bank's own transaction id), then run the same sweep
 * that routes every feed: client money stays in Finance, TD money lands in the books.
 * Bounded to one year per call so a typo can't trigger a decade-long pull. */
export async function POST(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const { from_date, to_date } = body
  const DATE = /^\d{4}-\d{2}-\d{2}$/
  if (!DATE.test(from_date ?? '') || !DATE.test(to_date ?? '')) {
    return NextResponse.json({ error: 'from_date and to_date are required (YYYY-MM-DD)' }, { status: 400 })
  }
  if (from_date > to_date) {
    return NextResponse.json({ error: 'from_date must not be after to_date' }, { status: 400 })
  }
  const spanDays = (Date.parse(to_date) - Date.parse(from_date)) / 86400000
  if (spanDays > 366) {
    return NextResponse.json({ error: 'Range too large — backfill at most one year per call' }, { status: 400 })
  }

  try {
    const sync = await syncMercuryTransactions(from_date, to_date)
    const sweep = await sweepFeedsToOwnerLedger()
    return NextResponse.json({ sync, sweep })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Backfill failed' }, { status: 500 })
  }
}
