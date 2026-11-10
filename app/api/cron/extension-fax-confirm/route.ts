/**
 * Cron: Tax Return extension fax delivery check (plan item 7, dev job 6f555c9f)
 * Schedule: every 10 minutes via Vercel cron.
 *
 * Every Tax Return job with an extension fax on record (a Form 7004 sent from the extension box) that is not yet confirmed is checked with Faxage
 * (lib/fax/extension-fax-delivery.ts):
 *  - delivered → the Form 7004 and the Faxage receipt are merged into ONE document saved in the company's Tax folder, the job moves to
 *    "Extension Filed" and the client gets the "extension filed" message in the portal chat;
 *  - failed / waiting too long → ONE alert per fax, nothing moves;
 *  - still waiting → looked at again next run.
 * Idempotent: a fax that already has its "confirmed" marker is skipped, so a re-run or a clash with the box's "Check now" does nothing twice.
 * A job with no extension fax on record is never looked at (the list comes from the fax history, which holds only the extension faxes).
 *
 * Every run is written to cron_log (like the other crons), so the System Health page and the cron monitor see it: "error" when the job list could
 * not be read or at least one check could not be completed (it is retried on the next run), "success" otherwise.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { logCron } from '@/lib/cron-log'
import { processExtensionFaxDelivery, realExtensionFaxDeps } from '@/lib/fax/extension-fax-delivery'
import { EXTENSION_FAX_MARKERS, EXTENSION_FAX_PURPOSE } from '@/lib/fax/extension-fax'

const ENDPOINT = '/api/cron/extension-fax-confirm'

export async function GET(request: NextRequest) {
  // Auth: CRON_SECRET (skipped in local dev when none is set, like the other crons)
  const authHeader = request.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- action_log columns used here are not all in the generated types
    const db = supabaseAdmin as any
    // the jobs that have an extension fax on record ...
    const faxes = await db.from('action_log').select('service_delivery_id, details').eq('action_type', 'fax_sent').eq('details->>purpose', EXTENSION_FAX_PURPOSE)
    if (faxes.error) {
      logCron({ endpoint: ENDPOINT, status: 'error', duration_ms: Date.now() - startTime, error_message: faxes.error.message, details: { stage: 'list_faxes' } })
      return NextResponse.json({ success: false, error: faxes.error.message }, { status: 500 })
    }
    // ... minus the faxes already confirmed
    const done = await db.from('action_log').select('service_delivery_id, details').eq('action_type', EXTENSION_FAX_MARKERS.confirmed)
    if (done.error) {
      logCron({ endpoint: ENDPOINT, status: 'error', duration_ms: Date.now() - startTime, error_message: done.error.message, details: { stage: 'list_confirmed' } })
      return NextResponse.json({ success: false, error: done.error.message }, { status: 500 })
    }
    const confirmed = new Set<string>((done.data ?? []).map((r: { service_delivery_id: string | null; details: { job_id?: string } | null }) => `${r.service_delivery_id}:${r.details?.job_id ?? ''}`))
    const open = new Set<string>()
    for (const r of (faxes.data ?? []) as Array<{ service_delivery_id: string | null; details: { job_id?: string } | null }>) {
      if (r.service_delivery_id && !confirmed.has(`${r.service_delivery_id}:${r.details?.job_id ?? ''}`)) open.add(r.service_delivery_id)
    }

    const deps = await realExtensionFaxDeps()
    const tally: Record<string, number> = {}
    const errors: string[] = []
    for (const id of Array.from(open)) {
      const r = await processExtensionFaxDelivery(id, deps)
      tally[r.outcome] = (tally[r.outcome] ?? 0) + 1
      if (r.outcome === 'error') errors.push(`${id}: ${r.error}`)
    }
    if (errors.length > 0) console.error('[extension-fax-confirm] checks that could not be completed (retried next run):', errors)

    const checked = open.size
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
