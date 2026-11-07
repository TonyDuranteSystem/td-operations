/**
 * Cron: Tax Return fax delivery check (plan item 6, dev job 6f555c9f)
 * Schedule: every 10 minutes via Vercel cron.
 *
 * Every Tax Return job sitting at "Signed" with a return fax on record is checked with Faxage (lib/fax/return-fax-delivery.ts):
 *  - delivered → the Faxage receipt is saved in the company's Tax folder ("Fax Confirmation", tax year stamped) and the job moves to "TR Filed";
 *  - failed / waiting too long → ONE alert per fax, nothing moves;
 *  - still waiting → looked at again next run.
 * Idempotent: a job that already has its "confirmed" marker is skipped, so a re-run or a clash with the box's "Check now" does nothing twice.
 * A job with no fax on record costs one cheap lookup and no call to Faxage.
 *
 * Every run is written to cron_log (like the other crons), so the System Health page and the cron monitor see it: "error" when the job list could
 * not be read or at least one check could not be completed (it is retried on the next run), "success" otherwise.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { logCron } from '@/lib/cron-log'
import { processReturnFaxDelivery, realReturnFaxDeps } from '@/lib/fax/return-fax-delivery'
import { TAX_RETURN_SIGN_STAGES } from '@/lib/flows/tax-return-sign-stages'

const ENDPOINT = '/api/cron/return-fax-confirm'

export async function GET(request: NextRequest) {
  // Auth: CRON_SECRET (skipped in local dev when none is set, like the other crons)
  const authHeader = request.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  try {
    const { data: jobs, error } = await supabaseAdmin
      .from('service_deliveries')
      .select('id')
      .eq('service_type', 'Tax Return')
      .eq('stage', TAX_RETURN_SIGN_STAGES.signed)
      .neq('status', 'cancelled')
    if (error) {
      logCron({ endpoint: ENDPOINT, status: 'error', duration_ms: Date.now() - startTime, error_message: error.message, details: { stage: 'list_jobs' } })
      return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }

    const deps = await realReturnFaxDeps()
    const tally: Record<string, number> = {}
    const errors: string[] = []
    for (const job of jobs ?? []) {
      const r = await processReturnFaxDelivery(job.id as string, deps)
      tally[r.outcome] = (tally[r.outcome] ?? 0) + 1
      if (r.outcome === 'error') errors.push(`${job.id}: ${r.error}`)
    }
    if (errors.length > 0) console.error('[return-fax-confirm] checks that could not be completed (retried next run):', errors)

    const checked = (jobs ?? []).length
    logCron({
      endpoint: ENDPOINT,
      status: errors.length > 0 ? 'error' : 'success',
      duration_ms: Date.now() - startTime,
      ...(errors.length > 0 ? { error_message: errors[0].slice(0, 300) } : {}),
      details: { checked, tally, errors: errors.slice(0, 5) },
    })
    return NextResponse.json({ success: true, checked, tally, errors })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logCron({ endpoint: ENDPOINT, status: 'error', duration_ms: Date.now() - startTime, error_message: message.slice(0, 300), details: { stage: 'exception' } })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
