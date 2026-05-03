/**
 * Admin endpoint — manual Airwallex deposits backfill.
 *
 * The /api/cron/airwallex-sync endpoint requires CRON_SECRET bearer auth and
 * runs against a fixed 90-day window when triggered from the Vercel cron
 * dashboard. This endpoint uses the regular admin session auth and accepts
 * a configurable date range so staff can backfill from any starting point
 * without sharing the cron secret.
 *
 * POST /api/admin/airwallex-backfill
 * Body: { days?: number } | { from?: 'YYYY-MM-DD' }
 *   - `days` (default 123 = back to Jan 1 from May 3 2026): days back from today
 *   - `from`: explicit start date (overrides `days`)
 * Returns: { ok: true, from, to, added, skipped, errors }
 */
import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { syncAirwallexDeposits } from '@/lib/airwallex-sync'

export const maxDuration = 60 // Vercel Pro: 60s

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isAdmin(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({})) as { days?: number; from?: string }
  const today = new Date()
  const to = today.toISOString().split('T')[0]

  let from: string
  if (body.from && /^\d{4}-\d{2}-\d{2}$/.test(body.from)) {
    from = body.from
  } else {
    const days = typeof body.days === 'number' && body.days > 0 ? Math.floor(body.days) : 123
    from = new Date(today.getTime() - days * 86400000).toISOString().split('T')[0]
  }

  try {
    const result = await syncAirwallexDeposits(from, to)
    return NextResponse.json({ ok: true, from, to, ...result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, from, to, error: msg }, { status: 500 })
  }
}
