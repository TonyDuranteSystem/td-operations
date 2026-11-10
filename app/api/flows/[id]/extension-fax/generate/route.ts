/**
 * POST /api/flows/[id]/extension-fax/generate — make the Form 7004 of this Tax Return job (plan item 7, dev job 6f555c9f).
 *
 * Staff review the pre-filled form in the box, then press Generate: this fills the OFFICIAL IRS Form 7004 (lib/pdf/7004-fill.ts) with exactly what
 * they confirmed and saves it in the company's Tax folder as the job's WORKING COPY ("Form 7004 (as faxed) - …", type Form 7004, hidden from the
 * client). The box then shows it for a look, and the fax engine sends THAT file. Generating again (a correction) saves a newer copy as long as
 * no fax is on record for the job; once a fax went out (or was started and never confirmed) the copy is what the IRS got and is not replaced here.
 *
 * Body: { companyName, ein, street, suite?, city, state, zip, taxYear, generate_id, confirm_late? }. Past the return's ORIGINAL due date a Form 7004 is late:
 * it is only made when staff confirmed that on purpose (confirm_late), never by accident. Staff-only. [id] = service_delivery_id.
 * A plain sentence on every refusal; the data that cannot make a valid form is a 400 and nothing is saved.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { taxReturnYear } from '@/lib/flows/resolve-flows'
import { fill7004, form7004Problem, type Form7004FillData } from '@/lib/pdf/7004-fill'
import { EXTENSION_FAX_MARKERS, EXTENSION_FAX_PURPOSE, EXTENSION_STAGES, isPastOriginalDueDate, longDate, originalDueDateIso, todayNewYork, usesExtensionFaxBox, workingCopyName } from '@/lib/fax/extension-fax'

const text = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }
  const sdId = params.id
  const body = await req.json().catch(() => ({}))
  const generateId = typeof body.generate_id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(body.generate_id) ? body.generate_id : null
  if (!generateId) return NextResponse.json({ success: false, error: 'Please reload the page and try again.' }, { status: 400 })

  const data: Form7004FillData = {
    companyName: text(body.companyName),
    ein: text(body.ein, 20),
    street: text(body.street),
    suite: text(body.suite) || undefined,
    city: text(body.city),
    state: text(body.state, 60),
    zip: text(body.zip, 20),
    taxYear: Number(body.taxYear),
  }
  const problem = form7004Problem(data)
  if (problem) return NextResponse.json({ success: false, error: problem }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service_name / action_log columns are not all in the generated types
  const db = supabaseAdmin as any
  const sdRes = await db
    .from('service_deliveries')
    .select('id, account_id, service_type, service_name, stage, status, due_date, created_at, stage_entered_at')
    .eq('id', sdId)
    .maybeSingle()
  if (sdRes.error) return NextResponse.json({ success: false, error: 'Could not check the job. Nothing was made. Please try again.' }, { status: 503 })
  const sd = sdRes.data
  if (!sd) return NextResponse.json({ success: false, error: 'Flow not found' }, { status: 404 })
  if (sd.service_type !== 'Tax Return') return NextResponse.json({ success: false, error: 'This box belongs to a Tax Return job.' }, { status: 400 })
  if (sd.status === 'cancelled' || sd.stage !== EXTENSION_STAGES.waiting) {
    return NextResponse.json({ success: false, error: `The Form 7004 is made while the job is at "${EXTENSION_STAGES.waiting}".` }, { status: 409 })
  }
  const accountId = (sd.account_id as string | null) ?? null
  if (!accountId) return NextResponse.json({ success: false, error: 'This job has no company, so there is no storage to keep the Form 7004 in.' }, { status: 409 })

  const acc = await db.from('accounts').select('company_name, entity_type').eq('id', accountId).maybeSingle()
  if (acc.error) return NextResponse.json({ success: false, error: 'Could not check the company. Nothing was made. Please try again.' }, { status: 503 })
  if (!usesExtensionFaxBox((acc.data?.entity_type as string | null | undefined) ?? null)) {
    return NextResponse.json({ success: false, error: 'The Form 7004 is only generated here for single-member LLCs.' }, { status: 409 })
  }

  // a fax on record (or started and never confirmed) means the copy is what the IRS got: it is not replaced
  const faxRes = await db
    .from('action_log')
    .select('id, action_type, details')
    .eq('service_delivery_id', sdId)
    .in('action_type', ['fax_sent', 'fax_claim'])
    .eq('details->>purpose', EXTENSION_FAX_PURPOSE)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (faxRes.error) return NextResponse.json({ success: false, error: 'Could not check the fax history. Nothing was made. Please try again.' }, { status: 503 })
  if (faxRes.data) {
    const faxJobId = (faxRes.data.details as { job_id?: string } | null)?.job_id ?? null
    let failed = false
    if (faxRes.data.action_type === 'fax_sent' && faxJobId) {
      const m = await db
        .from('action_log')
        .select('id')
        .eq('service_delivery_id', sdId)
        .eq('action_type', EXTENSION_FAX_MARKERS.failed)
        .eq('details->>job_id', faxJobId)
        .limit(1)
      if (m.error) return NextResponse.json({ success: false, error: 'Could not check the fax history. Nothing was made. Please try again.' }, { status: 503 })
      failed = Array.isArray(m.data) && m.data.length > 0
    }
    if (!failed) return NextResponse.json({ success: false, error: 'A Form 7004 was already faxed for this job. It cannot be replaced here.' }, { status: 409 })
  }

  // a Form 7004 filed after the return's original due date is late: only on purpose
  const jobYear = taxReturnYear(sd)
  if (isPastOriginalDueDate(jobYear, todayNewYork()) && body.confirm_late !== true) {
    return NextResponse.json({
      success: false,
      late: true,
      error: `The original due date of the ${jobYear} return (${longDate(originalDueDateIso(jobYear as number), false)}) has passed, so a Form 7004 filed now is late and may not count as an extension. Tick the box to confirm only if you know it is still valid.`,
    }, { status: 409 })
  }

  let bytes: Uint8Array
  try {
    bytes = await fill7004(data)
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : 'Could not make the Form 7004.' }, { status: 500 })
  }

  const year = taxReturnYear(sd)
  const company = ((acc.data?.company_name as string | null | undefined) ?? '').trim() || data.companyName
  try {
    const { saveDocumentForAccount, CompanyMovingError } = await import('@/lib/crm-store/save-for-account')
    let saved
    try {
      saved = await saveDocumentForAccount({
        accountId,
        name: workingCopyName(company, year),
        bytes: Buffer.from(bytes),
        mimeType: 'application/pdf',
        folder: 'tax',
        documentType: 'form_7004',
        callerKey: `extension-7004-working:${sdId}:${generateId}`,
        portalVisible: false, // the working copy is internal; the client sees the merged document once the fax is delivered
        periodYear: year,
        actor: user?.id ?? null,
        row: { document_type_name: 'Form 7004', category: 3, status: 'classified', service_delivery_id: sdId, flow_stage: EXTENSION_STAGES.waiting },
      })
    } catch (e) {
      if (e instanceof CompanyMovingError) return NextResponse.json({ success: false, error: 'This company\'s files are being moved right now. Try again in a few minutes.' }, { status: 409 })
      throw e
    }
    if (saved.route !== 'store') {
      return NextResponse.json({ success: false, error: 'This company has no storage to keep the Form 7004 in, so it was not made.' }, { status: 409 })
    }
    return NextResponse.json({ success: true, document_id: saved.documentRowId, file_name: workingCopyName(company, year) })
  } catch (e) {
    return NextResponse.json({ success: false, error: `Could not save the Form 7004: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 })
  }
}
