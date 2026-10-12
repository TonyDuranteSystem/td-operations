/**
 * CRON: queue the CRM storage → Google Drive backup, then check that it is healthy (Drive cutover Phase 4, dev job ad09ea91).
 *
 * Every 10 minutes. It does NOT copy anything itself: it queues one `crm_store_backup_owner` job per storage that needs a run
 * (the job runner does the copying, one storage per job, stopping cleanly before its time limit) and then runs the alarm
 * (`lib/crm-store/backup-alarm.ts`); a non-empty alarm raises ONE system error so staff see it on the error board.
 *
 * SAFE BY DEFAULT: while the kill switch STORE_BACKUP_ENABLED is not "1" it queues nothing and says so ("disabled"), so this
 * route can be deployed long before the backup is switched on. Auth: Bearer CRON_SECRET — a missing env var refuses,
 * it does not fail open.
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
    const { sweepBackups, backupEnabled } = await import('@/lib/crm-store/backup')
    if (!backupEnabled()) {
      logCron({ endpoint: 'store-backup', status: 'success', duration_ms: Date.now() - startTime, details: { status: 'disabled' } })
      return NextResponse.json({ success: true, status: 'disabled' })
    }
    const swept = await sweepBackups()
    const { runBackupAlarm } = await import('@/lib/crm-store/backup-alarm')
    const alarm = await runBackupAlarm()
    if (alarm.problems.length > 0) {
      const { reportSystemError } = await import('@/lib/system-errors')
      await reportSystemError({
        source: 'server',
        route: '/api/cron/store-backup',
        method: 'GET',
        message: `CRM storage backup needs attention: ${alarm.problems.join('; ')}`,
        context: { problems: alarm.problems, counts: alarm.counts },
      })
    }
    logCron({ endpoint: 'store-backup', status: 'success', duration_ms: Date.now() - startTime, details: { swept, problems: alarm.problems.length } })
    return NextResponse.json({ success: true, swept, problems: alarm.problems })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logCron({ endpoint: 'store-backup', status: 'error', duration_ms: Date.now() - startTime, error_message: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
