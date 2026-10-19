/**
 * CRON: company status changes (Storage check Phase 3, dev job f855295a) — turns each `account_status_events` row (left by a database
 * trigger whenever accounts.status changes) into ONE staff-only note in the Calendar's What's New. Changes nothing else.
 * Auth: Bearer CRON_SECRET. Before the migration exists it does nothing.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 120

import { NextRequest, NextResponse } from 'next/server'
import { logCron } from '@/lib/cron-log'

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const startTime = Date.now()
  try {
    const { processAccountStatusEvents } = await import('@/lib/accounts/status-change')
    const r = await processAccountStatusEvents({ budgetMs: 90_000 })
    if (r.processed > 0) logCron({ endpoint: 'account-status-events', status: 'success', duration_ms: Date.now() - startTime, details: { ...r } })
    return NextResponse.json({ success: true, ...r })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logCron({ endpoint: 'account-status-events', status: 'error', duration_ms: Date.now() - startTime, error_message: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
