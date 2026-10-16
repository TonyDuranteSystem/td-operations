/**
 * CRON: Drive pickup (dev job ad09ea91) — saves the few named files listed in the `drive-pickup` sysdoc from a company's OLD Drive folder
 * into its storage. Reads Drive, writes only storage. Kill switch: STORE_DRIVE_PICKUP=1 (default OFF). Auth: Bearer CRON_SECRET.
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
    const { pickupEnabled, runPickupBatch } = await import('@/lib/crm-store/drive-pickup')
    if (!pickupEnabled()) return NextResponse.json({ success: true, status: 'disabled' })
    const r = await runPickupBatch({ budgetMs: 200_000 })
    if (r.done + r.failed + r.skipped > 0) logCron({ endpoint: 'drive-pickup', status: 'success', duration_ms: Date.now() - startTime, details: r })
    return NextResponse.json({ success: true, ...r })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logCron({ endpoint: 'drive-pickup', status: 'error', duration_ms: Date.now() - startTime, error_message: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
