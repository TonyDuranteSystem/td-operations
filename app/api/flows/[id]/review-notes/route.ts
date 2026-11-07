/**
 * Staff requests written NEXT TO a client's answer, before Request Changes is pressed (dev job 7df278cd, Shipment 1).
 *
 *   GET  → { success, writable, count, has_message }   how many requests are written and unsent for this job's tax submission
 *   PUT  { key, note }  → write (or, with an empty note, clear) the request next to ONE answer
 *   PUT  { message }    → write the optional overall note to the client
 *
 * [id] = service_delivery_id. The submission is the SAME one the review screen shows and Request Changes acts on
 * (loadTargetTaxSubmission). Nothing is sent to the client here: Request Changes sends the draft (see sync-flow-revision.ts).
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { requireStaffRoute } from '@/lib/auth/require-staff-route'
import { loadTargetTaxSubmission } from '@/lib/tax/target-submission'
import { saveReviewDraftChange } from '@/lib/tax/review-requests-db'
import { canWriteReviewRequests, draftCount, parseReviewRequests, setDraftMessage, setDraftNote } from '@/lib/tax/review-requests'

async function accountOf(serviceDeliveryId: string): Promise<{ accountId: string | null } | { error: NextResponse }> {
  const { data: sd, error } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, account_id')
    .eq('id', serviceDeliveryId)
    .maybeSingle()
  if (error) return { error: NextResponse.json({ success: false, error: `Could not load the job: ${error.message}` }, { status: 500 }) }
  if (!sd) return { error: NextResponse.json({ success: false, error: 'Flow (service delivery) not found' }, { status: 404 }) }
  return { accountId: sd.account_id }
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const sd = await accountOf(params.id)
  if ('error' in sd) return sd.error
  const loaded = await loadTargetTaxSubmission(sd.accountId)
  if (loaded.ok === false) {
    if (loaded.reason === 'error') return NextResponse.json({ success: false, error: `Could not load the submission: ${loaded.detail}` }, { status: 500 })
    return NextResponse.json({ success: true, writable: false, count: 0, has_message: false })
  }
  const data = parseReviewRequests(loaded.sub.review_requests)
  return NextResponse.json({
    success: true,
    writable: canWriteReviewRequests(loaded.sub.review_status),
    count: draftCount(data),
    has_message: data.draft.message !== '',
  })
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const body = (await req.json().catch(() => null)) as { key?: unknown; note?: unknown; message?: unknown } | null
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ success: false, error: 'Send { key, note } or { message }.' }, { status: 400 })
  }
  const hasKey = typeof body.key === 'string' && body.key !== ''
  const hasMessage = typeof body.message === 'string'
  if (!hasKey && !hasMessage) {
    return NextResponse.json({ success: false, error: 'Send { key, note } or { message }.' }, { status: 400 })
  }
  if (hasKey && typeof body.note !== 'string') {
    return NextResponse.json({ success: false, error: 'The request text is missing.' }, { status: 400 })
  }

  const sd = await accountOf(params.id)
  if ('error' in sd) return sd.error

  const result = await saveReviewDraftChange({
    accountId: sd.accountId,
    needsAnswerKey: hasKey ? (body.key as string) : undefined,
    apply: (current) => (hasKey ? setDraftNote(current, body.key as string, body.note as string) : setDraftMessage(current, body.message as string)),
  })

  switch (result.status) {
    case 'saved':
      return NextResponse.json({ success: true, count: draftCount(result.data), draft: result.data.draft })
    case 'no_submission':
    case 'no_account':
      return NextResponse.json({ success: false, error: 'This job has no submitted questionnaire to write requests on.' }, { status: 404 })
    case 'not_writable':
      return NextResponse.json(
        { success: false, error: 'This questionnaire is not open for requests right now (the client is editing it, or it is already approved).' },
        { status: 409 },
      )
    case 'unknown_answer':
      return NextResponse.json({ success: false, error: 'That answer is no longer in the submission. Reload the page.' }, { status: 409 })
    case 'conflict':
      return NextResponse.json({ success: false, error: 'Someone else was writing at the same moment. Try again.' }, { status: 409 })
    default:
      return NextResponse.json({ success: false, error: `Could not save the request: ${result.detail}` }, { status: 500 })
  }
}
