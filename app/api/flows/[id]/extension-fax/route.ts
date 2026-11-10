/**
 * GET /api/flows/[id]/extension-fax — state for the Tax Return "1st Installment Paid" step's extension box (components/flows/extension-fax-panel.tsx,
 * plan item 7, dev job 6f555c9f).
 *
 * Everything the box needs to decide what to show (the rules are pure, in lib/fax/extension-fax.ts):
 *  - whether this company's extension is faxed from here at all (single-member LLC) or the plain upload box is shown (everything else),
 *  - the Form 7004 generated in this job (the working copy) and the job's extension fax on record (fax_sent / an unconfirmed fax_claim carrying the
 *    extension purpose) and the delivery-check markers,
 *  - what the "Generate" form is pre-filled with (company name, EIN, mailing address, tax year) — staff review it before anything is made,
 *  - the pre-filled number (the last number an extension fax was DELIVERED to, else the IRS number) — editable in the box.
 * Generating is POST /api/flows/[id]/extension-fax/generate; the send is the shared fax engine (POST /api/tools/fax/send, purpose tag).
 *
 * Staff-only. [id] = service_delivery_id. A lookup that fails is an error (503), never "nothing was faxed".
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { taxReturnYear } from '@/lib/flows/resolve-flows'
import type { FaxLogRow, MarkerRow } from '@/lib/fax/return-fax'
import {
  buildExtensionFaxState,
  EXTENSION_FAX_MARKERS,
  EXTENSION_FAX_PURPOSE,
  extensionFaxCover,
  extensionFaxReason,
  lastDeliveredNumber,
  pickWorkingCopy,
  prefillAddress,
  WORKING_COPY_PREFIX,
  type WorkingCopyRow,
} from '@/lib/fax/extension-fax'

const NOT_CHECKED = 'Could not check this job\'s extension. Please reload; nothing was sent.'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  const sdId = params.id
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service_name / action_log columns are not all in the generated types
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
  let ein = ''
  let suite: string | null = null
  let mailing: Parameters<typeof prefillAddress>[0] = null
  if (accountId) {
    const acc = await db
      .from('accounts')
      .select('company_name, entity_type, ein_number, suite_number, mailing_address:addresses!business_mailing_address_id(address_line1, address_line2, city, state, zip)')
      .eq('id', accountId)
      .maybeSingle()
    if (acc.error) return NextResponse.json({ success: false, error: NOT_CHECKED }, { status: 503 })
    company = ((acc.data?.company_name as string | null | undefined) ?? '').trim() || company
    entityType = (acc.data?.entity_type as string | null | undefined) ?? null
    ein = ((acc.data?.ein_number as string | null | undefined) ?? '').trim()
    suite = (acc.data?.suite_number as string | null | undefined) ?? null
    mailing = (acc.data?.mailing_address as Parameters<typeof prefillAddress>[0]) ?? null
  }

  // the Form 7004 generated in THIS job
  let docs: WorkingCopyRow[] = []
  if (accountId) {
    const docRes = await db
      .from('documents')
      .select('id, file_name, drive_file_id, created_at')
      .eq('service_delivery_id', sdId)
      .ilike('file_name', `${WORKING_COPY_PREFIX}%`)
      .order('created_at', { ascending: false })
      .limit(5)
    if (docRes.error) return NextResponse.json({ success: false, error: NOT_CHECKED }, { status: 503 })
    docs = (docRes.data ?? []) as WorkingCopyRow[]
  }

  // the job's latest EXTENSION fax (a send never confirmed counts: the box must not offer a plain Send then) and the delivery-check markers
  const faxRes = await db
    .from('action_log')
    .select('id, action_type, created_at, details')
    .eq('service_delivery_id', sdId)
    .in('action_type', ['fax_sent', 'fax_claim'])
    .eq('details->>purpose', EXTENSION_FAX_PURPOSE)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (faxRes.error) return NextResponse.json({ success: false, error: NOT_CHECKED }, { status: 503 })
  const markerRes = await db
    .from('action_log')
    .select('action_type, created_at, details')
    .eq('service_delivery_id', sdId)
    .in('action_type', Object.values(EXTENSION_FAX_MARKERS))
    .order('created_at', { ascending: false })
    .limit(20)
  if (markerRes.error) return NextResponse.json({ success: false, error: NOT_CHECKED }, { status: 503 })

  // the number the last delivered extension fax (of ANY job) went to
  const lastRes = await db
    .from('action_log')
    .select('details')
    .eq('action_type', EXTENSION_FAX_MARKERS.confirmed)
    .order('created_at', { ascending: false })
    .limit(5)
  if (lastRes.error) return NextResponse.json({ success: false, error: NOT_CHECKED }, { status: 503 })

  const year = taxReturnYear(sd)
  const state = buildExtensionFaxState({
    entityType,
    workingCopy: pickWorkingCopy(docs),
    latestFax: (faxRes.data as FaxLogRow | null) ?? null,
    markers: (markerRes.data ?? []) as MarkerRow[],
  })
  const address = prefillAddress(mailing, suite)

  return NextResponse.json(
    {
      success: true,
      state,
      account_id: accountId,
      company,
      year,
      prefill: { companyName: company === 'this company' ? '' : company, ein, ...address, taxYear: year },
      fax_number: lastDeliveredNumber((lastRes.data ?? []) as Array<{ details: { faxno?: string | null } | null }>),
      default_reason: extensionFaxReason(company, year),
      default_cover: extensionFaxCover(company, year),
    },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  )
}
