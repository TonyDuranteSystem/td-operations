/**
 * CRON: Drive-vs-storage gap check (dev job ad09ea91). READ-ONLY. Every 5 minutes it checks a few more companies' old Drive folders
 * and keeps the result in the `drive-gap-report` sysdoc; when every company is done it does nothing. No button, no page.
 * Kill switch: STORE_DRIVE_GAP=1 (default OFF). Auth: Bearer CRON_SECRET — a missing env var refuses.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 300

import { NextRequest, NextResponse } from 'next/server'
import { logCron } from '@/lib/cron-log'

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const startTime = Date.now()
  try {
    const { gapEnabled, runGapBatch } = await import('@/lib/crm-store/drive-gap-run')
    if (!gapEnabled()) return NextResponse.json({ success: true, status: 'disabled' })
    const r = await runGapBatch({ budgetMs: 200_000 })
    if (r.status !== 'done' || r.checked > 0) logCron({ endpoint: 'drive-gap', status: 'success', duration_ms: Date.now() - startTime, details: r })
    return NextResponse.json({ success: true, ...r })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logCron({ endpoint: 'drive-gap', status: 'error', duration_ms: Date.now() - startTime, error_message: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
