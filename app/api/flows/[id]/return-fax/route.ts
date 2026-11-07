/**
 * GET /api/flows/[id]/return-fax — state for the Tax Return "Signed" step's fax box (components/flows/return-fax-panel.tsx, plan item 6).
 *
 * Everything the box needs to decide what to show (the rules are pure, in lib/fax/return-fax.ts):
 *  - whether this company's return is faxed from here at all (single-member LLC) or by hand (everything else),
 *  - the SIGNED COPY of this job (the newest completed e-sign document tied to the job, found in the company's documents),
 *  - the job's latest fax on record (fax_sent, or an unconfirmed fax_claim) and the delivery-check markers,
 *  - the pre-filled number / reason / cover note (editable in the box).
 * The send itself goes through the shared fax engine (POST /api/tools/fax/send), exactly like the SS-4 box.
 *
 * Staff-only. [id] = service_delivery_id. A lookup that fails is an error (503), never "nothing was faxed".
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { taxReturnYear } from '@/lib/flows/resolve-flows'
import {
  buildReturnFaxState,
  IRS_RETURN_FAX_NUMBER,
  pickSignedCopy,
  RETURN_FAX_MARKERS,
  returnFaxCover,
  returnFaxReason,
  type DocumentRowLite,
  type FaxLogRow,
  type MarkerRow,
  type SignedEnvelopeRow,
} from '@/lib/fax/return-fax'

const NOT_CHECKED = 'Could not check this job\'s fax history. Please reload; nothing was sent.'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  const sdId = params.id
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service_name / esign_* / action_log columns are not all in the generated types
  const db = supabaseAdmin as any

  const sdRes = await db
    .from('service_deliveries')
    .select('id, account_id, service_type, service_name, due_date, created_at, stage_entered_at')
    .eq('id', sdId)
    .maybeSingle()
  if (sdRes.error) return NextResponse.json({ success: false, error: NOT_CHECKED }, { status: 503 })
  const sd = sdRes.data
  if (!sd) return NextResponse.json({ success: false, error: 'Flow not found' }, { status: 404 })
  if (sd.service_type !== 'Tax Return') return NextResponse.json({ success: false, error: 'This box belongs to a Tax Return job.' }, { status: 400 })
  const accountId = (sd.account_id as string | null) ?? null

  let company = 'this company'
  let entityType: string | null = null
  if (accountId) {
    const acc = await db.from('accounts').select('company_name, entity_type').eq('id', accountId).maybeSingle()
    if (acc.error) return NextResponse.json({ success: false, error: NOT_CHECKED }, { status: 503 })
    company = ((acc.data?.company_name as string | null | undefined) ?? '').trim() || company
    entityType = (acc.data?.entity_type as string | null | undefined) ?? null
  }

  // the signed copy of THIS job
  const envRes = await db
    .from('esign_envelopes')
    .select('id, status, completed_at, signed_pdf_drive_id, document_name')
    .eq('service_delivery_id', sdId)
    .eq('status', 'completed')
  if (envRes.error) return NextResponse.json({ success: false, error: NOT_CHECKED }, { status: 503 })
  const envelopes = (envRes.data ?? []) as SignedEnvelopeRow[]
  const pointers = envelopes.map((e) => e.signed_pdf_drive_id).filter((p): p is string => !!p)
  let docs: DocumentRowLite[] = []
  if (pointers.length > 0) {
    const docRes = await db.from('documents').select('id, file_name, drive_file_id').in('drive_file_id', pointers)
    if (docRes.error) return NextResponse.json({ success: false, error: NOT_CHECKED }, { status: 503 })
    docs = (docRes.data ?? []) as DocumentRowLite[]
  }

  // the job's latest fax (a send never confirmed counts: the box must not offer a plain Send then) and the delivery-check markers
  const faxRes = await db
    .from('action_log')
    .select('id, action_type, created_at, details')
    .eq('service_delivery_id', sdId)
    .in('action_type', ['fax_sent', 'fax_claim'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (faxRes.error) return NextResponse.json({ success: false, error: NOT_CHECKED }, { status: 503 })
  const markerRes = await db
    .from('action_log')
    .select('action_type, created_at, details')
    .eq('service_delivery_id', sdId)
    .in('action_type', Object.values(RETURN_FAX_MARKERS))
    .order('created_at', { ascending: false })
    .limit(20)
  if (markerRes.error) return NextResponse.json({ success: false, error: NOT_CHECKED }, { status: 503 })

  const year = taxReturnYear(sd)
  const state = buildReturnFaxState({
    entityType,
    signedCopy: pickSignedCopy(envelopes, docs),
    latestFax: (faxRes.data as FaxLogRow | null) ?? null,
    markers: (markerRes.data ?? []) as MarkerRow[],
  })

  return NextResponse.json(
    {
      success: true,
      state,
      account_id: accountId,
      company,
      year,
      irs_number: IRS_RETURN_FAX_NUMBER,
      default_reason: returnFaxReason(company, year),
      default_cover: returnFaxCover(company, year),
    },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  )
}
