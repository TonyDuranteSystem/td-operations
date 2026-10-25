/**
 * CRON: deletes CRM Storage upload leftovers (crm-uploads/store-staging/ in onboarding-uploads) older than 24 hours — they may be passports.
 * Auth: Bearer CRON_SECRET (fails closed when the secret is not set). `?dry_run=1` lists what would go and deletes nothing. Logs every run.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { logCron } from '@/lib/cron-log'

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const dryRun = ['1', 'true'].includes(req.nextUrl.searchParams.get('dry_run') ?? '')
  const startTime = Date.now()
  try {
    const { sweepStoreStaging } = await import('@/lib/crm-store/staging-sweep')
    const r = await sweepStoreStaging({ dryRun })
    logCron({ endpoint: 'store-staging-sweep', status: r.error ? 'error' : 'success', duration_ms: Date.now() - startTime, details: { ...r }, ...(r.error ? { error_message: r.error } : {}) })
    return NextResponse.json({ success: !r.error, ...r }, { status: r.error ? 500 : 200 })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logCron({ endpoint: 'store-staging-sweep', status: 'error', duration_ms: Date.now() - startTime, error_message: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
