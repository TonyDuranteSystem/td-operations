import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { generateLeasePDF } from '@/lib/lease-pdf'
import { NO_STORAGE_SENTENCE, NO_STORAGE_STATUS } from '@/lib/crm-store/no-storage'

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { lease_id } = await req.json() as { lease_id: string }

    if (!lease_id) {
      return NextResponse.json({ error: 'lease_id required' }, { status: 400 })
    }

    // Fetch lease record — including the ACTUAL signed date + term dates. This
    // tool produces a clean filed copy of an EXECUTED lease; it must reproduce
    // what the client signed, not whatever dates a caller types. Previously it
    // took signed_date / start_date / end_date from the request and stamped a
    // "/s/ Name" signature regardless — so it could file a "signed" document for
    // a lease nobody signed, or with dates that differ from the executed terms.
    const { data: lease } = await supabaseAdmin
      .from('lease_agreements')
      .select('*')
      .eq('id', lease_id)
      .single()

    if (!lease) return NextResponse.json({ error: 'Lease not found' }, { status: 404 })
    if (!lease.account_id) return NextResponse.json({ error: 'Lease has no account_id' }, { status: 400 })

    // Only a genuinely SIGNED lease can have a "signed copy" regenerated. This is
    // what stops a fabricated signature being filed for an unsigned lease.
    if (lease.status !== 'signed' || !lease.signed_at) {
      return NextResponse.json(
        { error: 'This lease is not signed yet — a signed copy can only be regenerated for an executed lease.' },
        { status: 400 },
      )
    }

    const signedDate = (lease.signed_at as string).split('T')[0]
    const isV2 = (lease.template_version ?? 1) === 2

    // Regenerate from the lease's OWN recorded data — the real signed date and the
    // agreed term dates. No caller-supplied dates.
    const pdfBytes = await generateLeasePDF({
      landlordName: lease.landlord_name ?? undefined,
      landlordAddress: lease.landlord_address ?? undefined,
      landlordSigner: lease.landlord_signer ?? undefined,
      landlordTitle: lease.landlord_title ?? undefined,
      tenantCompany: lease.tenant_company,
      tenantEin: lease.tenant_ein ?? undefined,
      tenantState: lease.tenant_state ?? undefined,
      tenantContactName: lease.tenant_contact_name,
      suiteNumber: lease.suite_number,
      squareFeet: lease.square_feet ?? undefined,
      effectiveDate: (lease.effective_date as string) ?? signedDate,
      termStartDate: lease.term_start_date as string,
      termEndDate: lease.term_end_date as string,
      monthlyRent: lease.monthly_rent ?? undefined,
      yearlyRent: lease.yearly_rent ?? undefined,
      securityDeposit: lease.security_deposit ?? undefined,
      lateFee: lease.late_fee ?? undefined,
      lateFeePerDay: lease.late_fee_per_day ?? undefined,
      signedDate: isV2 ? ((lease.effective_date as string) ?? signedDate) : signedDate,
      ...(isV2 ? { templateVersion: 2, operatingAddress: lease.operating_address ?? null, tenantTitle: lease.tenant_title ?? undefined } : {}),
    })

    // Upload to Supabase Storage
    const storagePath = `${lease.token}/lease-signed-regen-${Date.now()}.pdf`
    const { error: uploadErr } = await supabaseAdmin.storage
      .from('signed-leases')
      .upload(storagePath, pdfBytes, { contentType: 'application/pdf', upsert: true })

    if (uploadErr) {
      return NextResponse.json({ error: `Storage upload failed: ${uploadErr.message}` }, { status: 500 })
    }

    // The regenerated lease goes to the company's storage — the same file key as the original signing, so it is a new
    // VERSION of that file. A company with no storage gets one plain sentence back.
    {
      const { saveSignedPdfForAccount } = await import('@/lib/crm-store/save-for-account')
      const routed = await saveSignedPdfForAccount({
        accountId: lease.account_id,
        fileName: `Lease Agreement - ${lease.tenant_company} (Suite ${lease.suite_number}, Signed).pdf`,
        bytes: Buffer.from(pdfBytes), label: 'Lease Agreement', category: 1, callerKey: `lease-signed:${lease.id}`, documentType: 'office_lease',
      })
      if (routed.route === 'store') {
        await supabaseAdmin
          .from('lease_agreements')
          .update({ pdf_storage_path: storagePath, pdf_drive_file_id: routed.pointer, updated_at: new Date().toISOString() })
          .eq('id', lease_id)
        return NextResponse.json({ ok: true, driveFileId: routed.pointer, storagePath })
      }
    }

    return NextResponse.json({ error: NO_STORAGE_SENTENCE }, { status: NO_STORAGE_STATUS })
  } catch (err) {
    console.error('[regen-lease-pdf]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
