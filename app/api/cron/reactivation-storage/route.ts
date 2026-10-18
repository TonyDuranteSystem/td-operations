/**
 * CRON: reactivation → old documents back into storage (Storage check Phase 3, slice 3a, dev job f855295a). Takes every company that went
 * from Closed / Cancelled / Offboarding / Delinquent back to Active and brings its old Drive documents into the new storage, step by step,
 * posting a plain note in the Calendar's What's New at each step. Reads Drive; writes only storage and the CRM's own document list.
 * Kill switch: STORE_REACTIVATION=1 (default OFF — it does nothing otherwise). Auth: Bearer CRON_SECRET.
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
    const { runReactivationBatch } = await import('@/lib/crm-store/reactivation')
    const r = await runReactivationBatch({ budgetMs: 230_000 })
    if (r.picked > 0) logCron({ endpoint: 'reactivation-storage', status: 'success', duration_ms: Date.now() - startTime, details: { ...r } })
    return NextResponse.json({ success: true, ...r })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logCron({ endpoint: 'reactivation-storage', status: 'error', duration_ms: Date.now() - startTime, error_message: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
