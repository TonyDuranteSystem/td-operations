import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { generateLeasePDF } from '@/lib/lease-pdf'
import { NO_STORAGE_STATUS, noStorageDecisionFor, receiveVerdictFor } from '@/lib/crm-store/no-storage'

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

    // Decide before building or storing anything: a company that cannot receive the copy is told so and nothing is changed.
    const verdict = await receiveVerdictFor(lease.account_id)
    if (!verdict.ok) return NextResponse.json({ error: verdict.sentence }, { status: NO_STORAGE_STATUS })

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

    // a refusal after the copy was uploaded must not leave the regenerated PDF behind in the bucket
    const dropOrphan = () => { supabaseAdmin.storage.from('signed-leases').remove([storagePath]).catch(() => {}) }

    // The regenerated lease goes to the company's storage — the same file key as the original signing, so it is a new
    // VERSION of that file. A company with no storage gets one plain sentence back.
    {
      const { saveSignedPdfForAccount, CompanyMovingError } = await import('@/lib/crm-store/save-for-account')
      const { plainStoreError } = await import('@/lib/crm-store/lock-errors')
      // The signed original is locked: a regenerated lease with different bytes is saved by the writer as a NEW file that replaces
      // it (the signed original stays in storage); the same bytes again change nothing.
      let routed
      try {
      routed = await saveSignedPdfForAccount({
        accountId: lease.account_id,
        fileName: `Lease Agreement - ${lease.tenant_company} (Suite ${lease.suite_number}, Signed).pdf`,
        bytes: Buffer.from(pdfBytes), label: 'Lease Agreement', category: 1, callerKey: `lease-signed:${lease.id}`, documentType: 'office_lease',
      })
      } catch (e) {
        // the company started moving after the check: a clean "try again", never a 500 (the lease row is not touched)
        if (e instanceof CompanyMovingError) {
          dropOrphan()
          return NextResponse.json({ error: e.message }, { status: 409 })
        }
        // any other refusal (a signed original that takes no new version is saved as a replacement file by the writer, so this is a
        // real failure): the regenerated copy is not left behind in the bucket, and staff get plain words — never raw "store:" text
        dropOrphan()
        console.error('[regen-lease-pdf] store save failed:', e)
        return NextResponse.json({ error: plainStoreError(e, 'The regenerated lease could not be saved in the company storage. Nothing was changed — please try again.') }, { status: 500 })
      }
      if (routed.route === 'store') {
        await supabaseAdmin
          .from('lease_agreements')
          .update({ pdf_storage_path: storagePath, pdf_drive_file_id: routed.pointer, updated_at: new Date().toISOString() })
          .eq('id', lease_id)
        return NextResponse.json({ ok: true, driveFileId: routed.pointer, storagePath })
      }
    }

    // No storage: Stop Drive S2 — nothing is ever written to Drive, so the company gets one plain sentence with the true
    // reason (and the lease row is left untouched).
    const decision = await noStorageDecisionFor(lease.account_id)
    dropOrphan()
    return NextResponse.json({ error: decision.sentence }, { status: NO_STORAGE_STATUS })
  } catch (err) {
    console.error('[regen-lease-pdf]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
