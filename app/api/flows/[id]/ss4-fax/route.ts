/**
 * GET /api/flows/[id]/ss4-fax — state for the Company Formation "SS-4 Signed"
 * stage fax panel (components/flows/ss4-fax-panel.tsx).
 *
 * Returns everything the panel needs to decide what to render:
 *  - ss4_status: the ss4_applications status (signed → ready to fax;
 *    awaiting_signature → re-sent, waiting for the client to sign again).
 *  - package: the combined "SS-4 + Articles (IRS Package)" workspace document for
 *    this flow, with `faxable` (true only when Drive-backed — the fax engine can
 *    only fax a Drive file). null when the package wasn't built (e.g. Articles
 *    missing → the ss4-signed route flags that separately).
 *  - already_faxed: the most recent fax_sent for this flow (drives the
 *    double-send confirm).
 *  - irs_number / default_reason / default_cover: pre-fill values (editable).
 *
 * Staff-only. [id] = service_delivery_id.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { IRS_EIN_FAX_DOMESTIC } from '@/lib/fax/faxage'

const PACKAGE_DOC_TYPE = 'SS-4 + Articles (IRS Package)'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  const serviceDeliveryId = params.id

  const { data: sd } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, account_id, service_type')
    .eq('id', serviceDeliveryId)
    .maybeSingle()

  if (!sd) {
    return NextResponse.json({ success: false, error: 'Flow not found' }, { status: 404 })
  }
  const accountId = (sd.account_id as string | null) ?? null

  // SS-4 status + company name (per account).
  let ss4Status: string | null = null
  let companyName = 'this company'
  if (accountId) {
    const { data: ss4 } = await supabaseAdmin
      .from('ss4_applications')
      .select('status, company_name')
      .eq('account_id', accountId)
      .maybeSingle()
    ss4Status = (ss4?.status as string | null) ?? null
    if (ss4?.company_name) companyName = ss4.company_name as string
  }

  // Combined package document for this flow (newest first).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service_delivery_id/document_type_name not in generated types
  const { data: pkgRow } = await (supabaseAdmin as any)
    .from('documents')
    .select('id, file_name, drive_file_id')
    .eq('service_delivery_id', serviceDeliveryId)
    .eq('document_type_name', PACKAGE_DOC_TYPE)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const packageDoc = pkgRow?.drive_file_id
    ? {
        document_id: pkgRow.id as string,
        file_name: (pkgRow.file_name as string | null) ?? 'IRS Package.pdf',
        // The fax engine downloads via Google Drive only; a `storage:` pointer
        // (no-Drive-folder edge) can't be faxed by the one-click button.
        faxable: !(pkgRow.drive_file_id as string).startsWith('storage:'),
      }
    : null

  // Most recent fax already sent for this flow.
  const { data: prior } = await supabaseAdmin
    .from('action_log')
    .select('created_at, details')
    .eq('action_type', 'fax_sent')
    .eq('service_delivery_id', serviceDeliveryId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const priorDetails = (prior?.details as { job_id?: string; faxno?: string } | null) ?? null

  return NextResponse.json(
    {
      success: true,
      ss4_status: ss4Status,
      account_id: accountId,
      package: packageDoc,
      already_faxed: prior
        ? { at: prior.created_at, job_id: priorDetails?.job_id ?? null, faxno: priorDetails?.faxno ?? null }
        : null,
      irs_number: IRS_EIN_FAX_DOMESTIC,
      default_reason: `SS-4 / EIN application - ${companyName}`,
      default_cover: `Signed SS-4 (EIN application) for ${companyName}.`,
    },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  )
}
