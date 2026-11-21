/**
 * GET /api/cron/waiting-for-client-reminders — daily (13:00 UTC ≈ 9 AM ET).
 *
 * Reminds clients who have not answered a conversation staff marked "waiting for client"
 * (3 days after the mark, then every 3 days, at most 2 reminders). See lib/portal/waiting-reminders.ts.
 */

export const maxDuration = 300
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { logCron } from '@/lib/cron-log'
import { runWaitingReminderSweep } from '@/lib/portal/waiting-reminders'

export async function GET(request: NextRequest) {
  const startTime = Date.now()
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const sweep = await runWaitingReminderSweep(new Date())
    const hasErrors = sweep.errors.length > 0
    logCron({
      endpoint: '/api/cron/waiting-for-client-reminders',
      status: hasErrors ? 'error' : 'success',
      duration_ms: Date.now() - startTime,
      error_message: hasErrors ? sweep.errors.join('; ').slice(0, 500) : undefined,
      details: { sweep },
    })
    return NextResponse.json({ success: true, sweep })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logCron({
      endpoint: '/api/cron/waiting-for-client-reminders',
      status: 'error',
      duration_ms: Date.now() - startTime,
      error_message: message,
    })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
