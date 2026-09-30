/**
 * CRON: release suites of closed companies whose lease has ended.
 *
 * Daily. A company's suite goes back to the pool (and is handed to the next new company, oldest released number first)
 * when the company is Closed or Cancelled AND has no lease in force. The database already does this the moment a company
 * is closed (and when its last lease is deleted); this sweep covers a lease whose term ENDS later, and any moment the
 * allocator was busy. Idempotent — running it twice releases nothing the second time.
 *
 * Auth: Bearer CRON_SECRET — a missing env var refuses, it does not fail open.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { logCron } from '@/lib/cron-log'
import { releaseEndedSuites } from '@/lib/operations/suite'

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const startTime = Date.now()
  try {
    const released = await releaseEndedSuites('cron:release-ended-suites')
    logCron({ endpoint: 'release-ended-suites', status: 'success', duration_ms: Date.now() - startTime, details: { released } })
    return NextResponse.json({ success: true, released })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logCron({ endpoint: 'release-ended-suites', status: 'error', duration_ms: Date.now() - startTime, error_message: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
