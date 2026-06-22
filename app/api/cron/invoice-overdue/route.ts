/**
 * Cron: Invoice Overdue Detection + Dunning
 * Schedule: daily at 9am ET via Vercel cron.
 *
 * Always marks Sent/Partial invoices Overdue when past due. Auto-sends
 * reminders ONLY when the UI toggle (app_settings `dunning_autosend`) is on —
 * throttled to DUNNING_RUN_CAP sends per run (gentle backlog rollout).
 * Shared logic lives in lib/billing/dunning.ts (also used by the dashboard
 * "Run reminders now" button).
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { logCron } from '@/lib/cron-log'
import { runDunning, isAutoSendEnabled } from '@/lib/billing/dunning'

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  try {
    const authHeader = req.headers.get('authorization')
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const autoSend = await isAutoSendEnabled()
    const summary = await runDunning({ autoSend })

    console.warn(`[invoice-overdue] Done: ${summary.marked_overdue} marked overdue, ${summary.reminders_queued} reminders queued (autoSend=${autoSend}, capped=${summary.capped})`)
    logCron({ endpoint: '/api/cron/invoice-overdue', status: 'success', duration_ms: Date.now() - startTime, details: summary as unknown as Record<string, unknown> })

    return NextResponse.json({ message: 'Invoice overdue check complete', ...summary })
  } catch (err) {
    console.error('[invoice-overdue] Error:', err)
    logCron({ endpoint: '/api/cron/invoice-overdue', status: 'error', duration_ms: Date.now() - startTime, error_message: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
