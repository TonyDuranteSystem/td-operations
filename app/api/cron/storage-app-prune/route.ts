/**
 * CRON (daily): housekeeping for the TD Storage Mac app (dev job 1992a087). Keeps 30 days of the change feed (an older cursor is told to
 * refresh in full) and deletes used / expired one-time codes, expired tokens and Macs signed out more than 90 days ago.
 * Auth: Bearer CRON_SECRET — a missing env var refuses. Needs the migration 20261017-0100 (on production only after Antonio's go).
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { logCron } from '@/lib/cron-log'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const startTime = Date.now()
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the new functions are not in the generated types until production
    const sb = supabaseAdmin as any
    const feed = await sb.rpc('store_change_log_prune')
    if (feed.error) throw new Error(`change log: ${feed.error.message}`)
    const signin = await sb.rpc('storage_app_prune')
    if (signin.error) throw new Error(`sign-in tables: ${signin.error.message}`)
    const details = { changeLogRowsDeleted: feed.data, signInRowsDeleted: signin.data }
    logCron({ endpoint: 'storage-app-prune', status: 'success', duration_ms: Date.now() - startTime, details })
    return NextResponse.json({ success: true, ...details })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logCron({ endpoint: 'storage-app-prune', status: 'error', duration_ms: Date.now() - startTime, error_message: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
