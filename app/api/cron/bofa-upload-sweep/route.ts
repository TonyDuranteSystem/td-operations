/**
 * CRON: deletes abandoned TEMPORARY bank-application uploads (bucket bofa-intake-uploads) that nothing needs any more — they may be
 * passports. The rule is in lib/bofa-intake/upload-sweep.ts: only objects older than 24 h, only when the application row proves
 * they are redundant or unreachable; CRM Storage is never touched.
 * Auth: Bearer CRON_SECRET (fails closed when the secret is not set). `?dry_run=1` lists counts and deletes nothing. Logs every run.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { logCron } from '@/lib/cron-log'
import { reportSystemError } from '@/lib/system-errors'

const ENDPOINT = '/api/cron/bofa-upload-sweep'

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const dryRun = ['1', 'true'].includes(req.nextUrl.searchParams.get('dry_run') ?? '')
  const startTime = Date.now()
  try {
    const { sweepBofaUploads } = await import('@/lib/bofa-intake/upload-sweep')
    const r = await sweepBofaUploads({ dryRun })
    logCron({ endpoint: 'bofa-upload-sweep', status: r.error ? 'error' : 'success', duration_ms: Date.now() - startTime, details: { ...r }, ...(r.error ? { error_message: r.error } : {}) })
    if (r.error) await reportSystemError({ source: 'server', route: ENDPOINT, message: `Bank application upload sweep: ${r.error}` }).catch(() => {})
    return NextResponse.json({ success: !r.error, ...r }, { status: r.error ? 500 : 200 })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logCron({ endpoint: 'bofa-upload-sweep', status: 'error', duration_ms: Date.now() - startTime, error_message: message })
    await reportSystemError({ source: 'server', route: ENDPOINT, message: `Bank application upload sweep crashed: ${message}` }).catch(() => {})
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
