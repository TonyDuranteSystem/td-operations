/**
 * CRON: deletes fax uploads that were staged for sending but never used (older than 24 hours) — they may be identity papers.
 * Auth: Bearer CRON_SECRET. Logs every run.
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
  const startTime = Date.now()
  try {
    const { sweepFaxStaging } = await import('@/lib/fax/staged-sweep')
    const r = await sweepFaxStaging()
    logCron({ endpoint: 'fax-staging-sweep', status: r.error ? 'error' : 'success', duration_ms: Date.now() - startTime, details: { ...r }, ...(r.error ? { error_message: r.error } : {}) })
    return NextResponse.json({ success: !r.error, ...r }, { status: r.error ? 500 : 200 })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logCron({ endpoint: 'fax-staging-sweep', status: 'error', duration_ms: Date.now() - startTime, error_message: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
