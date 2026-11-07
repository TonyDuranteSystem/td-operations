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
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { processReturnFaxDelivery, realReturnFaxDeps } from '@/lib/fax/return-fax-delivery'
import { TAX_RETURN_SIGN_STAGES } from '@/lib/flows/tax-return-sign-stages'

export async function GET(request: NextRequest) {
  // Auth: CRON_SECRET (skipped in local dev when none is set, like the other crons)
  const authHeader = request.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: jobs, error } = await supabaseAdmin
    .from('service_deliveries')
    .select('id')
    .eq('service_type', 'Tax Return')
    .eq('stage', TAX_RETURN_SIGN_STAGES.signed)
    .neq('status', 'cancelled')
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  const deps = await realReturnFaxDeps()
  const tally: Record<string, number> = {}
  const errors: string[] = []
  for (const job of jobs ?? []) {
    const r = await processReturnFaxDelivery(job.id as string, deps)
    tally[r.outcome] = (tally[r.outcome] ?? 0) + 1
    if (r.outcome === 'error') errors.push(`${job.id}: ${r.error}`)
  }
  if (errors.length > 0) console.error('[return-fax-confirm] checks that could not be completed (retried next run):', errors)
  return NextResponse.json({ success: true, checked: (jobs ?? []).length, tally, errors })
}
