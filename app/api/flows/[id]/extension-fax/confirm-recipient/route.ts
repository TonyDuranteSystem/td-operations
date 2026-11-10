/**
 * POST /api/flows/[id]/extension-fax/confirm-recipient — "Yes, that number was the IRS" on the Tax Return extension box (plan item 7).
 *
 * When Faxage says an extension fax was delivered to a number that is not the IRS number this system knows (the IRS can change its number, or the number
 * was mistyped), the delivery check HOLDS the job: nothing moves and the client is not told. A person looks at the number and, if it really is the IRS,
 * presses "Yes" in the box. This route records that confirmation (one marker, with who confirmed it) for THAT fax and runs the delivery check again, which
 * then files the extension as usual. The number is also remembered: later faxes to it are trusted. Idempotent. Staff-only. [id] = service_delivery_id.
 * Nothing is confirmed unless the check really did hold this fax (it refuses otherwise).
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { processExtensionFaxDelivery, realExtensionFaxDeps } from '@/lib/fax/extension-fax-delivery'
import { EXTENSION_FAX_MARKERS, EXTENSION_STAGES, faxDigits } from '@/lib/fax/extension-fax'

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }
  const sdId = params.id
  const deps = await realExtensionFaxDeps()

  const loaded = await deps.loadJob(sdId)
  if (loaded.error) return NextResponse.json({ success: false, error: 'Could not check the job. Nothing was confirmed. Please try again.' }, { status: 503 })
  const job = loaded.job
  if (!job) return NextResponse.json({ success: false, error: 'Flow not found' }, { status: 404 })
  if (job.service_type !== 'Tax Return') return NextResponse.json({ success: false, error: 'This box belongs to a Tax Return job.' }, { status: 400 })
  if (job.status === 'cancelled' || job.stage !== EXTENSION_STAGES.waiting) {
    return NextResponse.json({ success: false, error: `Nothing to confirm: the job is not waiting at "${EXTENSION_STAGES.waiting}".` }, { status: 409 })
  }

  const fax = await deps.latestFax(sdId)
  if (fax.error) return NextResponse.json({ success: false, error: 'Could not check the fax history. Nothing was confirmed. Please try again.' }, { status: 503 })
  const faxJobId = fax.row?.details?.job_id ?? null
  if (!fax.row || !faxJobId) return NextResponse.json({ success: false, error: 'There is no delivered extension fax on this job to confirm.' }, { status: 409 })

  const held = await deps.markerExists(EXTENSION_FAX_MARKERS.recipientUnverified, sdId, faxJobId)
  if (held.error) return NextResponse.json({ success: false, error: 'Could not check the fax history. Nothing was confirmed. Please try again.' }, { status: 503 })
  if (!held.exists) return NextResponse.json({ success: false, error: 'This fax is not waiting for a number confirmation.' }, { status: 409 })

  const already = await deps.markerExists(EXTENSION_FAX_MARKERS.recipientConfirmed, sdId, faxJobId)
  if (already.error) return NextResponse.json({ success: false, error: 'Could not check the fax history. Nothing was confirmed. Please try again.' }, { status: 503 })
  if (!already.exists) {
    const faxno = fax.row.details?.faxno ?? null
    const w = await deps.writeMarker(EXTENSION_FAX_MARKERS.recipientConfirmed, {
      sdId,
      accountId: job.account_id,
      faxJobId,
      summary: 'A person confirmed the extension fax went to the IRS',
      details: { job_id: faxJobId, faxno, faxno_digits: faxDigits(faxno), confirmed_by: user?.email ?? user?.id ?? null },
    })
    if (w.error) return NextResponse.json({ success: false, error: 'Could not save the confirmation. Nothing was filed. Please try again.' }, { status: 503 })
  }

  const result = await processExtensionFaxDelivery(sdId, deps)
  if (result.outcome === 'error') {
    return NextResponse.json({ success: false, result, error: `Confirmed, but the extension could not be filed yet: ${result.error}. It is retried every few minutes.` }, { status: 502 })
  }
  return NextResponse.json({ success: true, result })
}
