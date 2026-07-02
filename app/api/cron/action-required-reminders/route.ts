/**
 * GET /api/cron/action-required-reminders — daily (13:00 UTC ≈ 9 AM ET).
 *
 * Phase B of the Client Action-Required system (see
 * lib/portal/action-required-reminders.ts):
 *   1. Client reminders for SS-4s still awaiting signature (max 2 after the
 *      initial notification, 3-day spacing, stops when signed).
 *   2. Staff alert (support@) for formation SDs parked at "SS-4 Prepared"
 *      whose SS-4 is still draft / missing — the client-facing send never
 *      happened (the Michele Cotti failure mode).
 */

export const maxDuration = 300
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { logCron } from '@/lib/cron-log'
import {
  runSs4ClientReminderSweep,
  runSs4StaleDraftSweep,
} from '@/lib/portal/action-required-reminders'

export async function GET(request: NextRequest) {
  const startTime = Date.now()
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const now = new Date()
    const clientReminders = await runSs4ClientReminderSweep(now)
    const staffAlerts = await runSs4StaleDraftSweep(now)

    const hasErrors = clientReminders.errors.length > 0 || staffAlerts.errors.length > 0
    logCron({
      endpoint: '/api/cron/action-required-reminders',
      status: hasErrors ? 'error' : 'success',
      duration_ms: Date.now() - startTime,
      error_message: hasErrors
        ? [...clientReminders.errors, ...staffAlerts.errors].join('; ').slice(0, 500)
        : undefined,
      details: { clientReminders, staffAlerts },
    })

    return NextResponse.json({ success: true, clientReminders, staffAlerts })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logCron({
      endpoint: '/api/cron/action-required-reminders',
      status: 'error',
      duration_ms: Date.now() - startTime,
      error_message: message,
    })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
