import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { generateLeasePDF } from '@/lib/lease-pdf'
import { listFolder, uploadBinaryToDriveUpsert } from '@/lib/google-drive'

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { lease_id, signed_date, start_date, end_date } = await req.json() as {
      lease_id: string
      signed_date: string
      start_date: string
      end_date: string
    }

    if (!lease_id || !signed_date || !start_date || !end_date) {
      return NextResponse.json({ error: 'lease_id, signed_date, start_date, end_date required' }, { status: 400 })
    }

    // Fetch lease record
    const { data: lease } = await supabaseAdmin
      .from('lease_agreements')
      .select('id, token, tenant_company, tenant_ein, tenant_state, tenant_contact_name, landlord_name, landlord_address, landlord_signer, landlord_title, suite_number, square_feet, monthly_rent, yearly_rent, security_deposit, late_fee, late_fee_per_day, account_id')
      .eq('id', lease_id)
      .single()

    if (!lease) return NextResponse.json({ error: 'Lease not found' }, { status: 404 })
    if (!lease.account_id) return NextResponse.json({ error: 'Lease has no account_id' }, { status: 400 })

    // Generate PDF with new dates
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
      effectiveDate: signed_date,
      termStartDate: start_date,
      termEndDate: end_date,
      monthlyRent: lease.monthly_rent ?? undefined,
      yearlyRent: lease.yearly_rent ?? undefined,
      securityDeposit: lease.security_deposit ?? undefined,
      lateFee: lease.late_fee ?? undefined,
      lateFeePerDay: lease.late_fee_per_day ?? undefined,
      signedDate: signed_date,
    })

    // Upload to Supabase Storage
    const storagePath = `${lease.token}/lease-signed-regen-${Date.now()}.pdf`
    const { error: uploadErr } = await supabaseAdmin.storage
      .from('signed-leases')
      .upload(storagePath, pdfBytes, { contentType: 'application/pdf', upsert: true })

    if (uploadErr) {
      return NextResponse.json({ error: `Storage upload failed: ${uploadErr.message}` }, { status: 500 })
    }

    // Get account Drive folder
    const { data: acct } = await supabaseAdmin
      .from('accounts')
      .select('drive_folder_id, company_name')
      .eq('id', lease.account_id)
      .single()

    if (!acct?.drive_folder_id) {
      return NextResponse.json({ error: 'Account has no Drive folder' }, { status: 400 })
    }

    // Find Company subfolder
    const folderResult = await listFolder(acct.drive_folder_id) as {
      files?: { id: string; name: string; mimeType: string }[]
    }
    const companyFolder = folderResult.files?.find(
      f => f.name.includes('Company') && f.mimeType === 'application/vnd.google-apps.folder'
    )
    const targetFolderId = companyFolder?.id || acct.drive_folder_id

    // Upload to Drive
    const fileName = `Lease Agreement - ${lease.tenant_company} (Suite ${lease.suite_number}, Signed).pdf`
    // Stable name -> UPSERT: regeneration refreshes the one existing file in place (LT Program incident class).
    const driveResult = await uploadBinaryToDriveUpsert(
      fileName, Buffer.from(pdfBytes), 'application/pdf', targetFolderId
    ) as { id: string }

    // Update or insert documents record
    const { data: existingDoc } = await supabaseAdmin
      .from('documents')
      .select('id')
      .eq('account_id', lease.account_id)
      .in('document_type_name', ['Office Lease', 'Lease Agreement'])
      .eq('portal_visible', true)
      .limit(1)
      .maybeSingle()

    const driveLink = `https://drive.google.com/file/d/${driveResult.id}/view`

    if (existingDoc) {
      await supabaseAdmin
        .from('documents')
        .update({
          drive_file_id: driveResult.id,
          drive_link: driveLink,
          file_name: fileName,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingDoc.id)
    } else {
      await supabaseAdmin
        .from('documents')
        .insert({
          account_id: lease.account_id,
          file_name: fileName,
          document_type_name: 'Office Lease',
          category: 1,
          category_name: 'Company',
          drive_file_id: driveResult.id,
          drive_link: driveLink,
          status: 'classified',
          confidence: '1.0',
          processed_at: new Date().toISOString(),
          portal_visible: true,
        })
    }

    // Update lease record
    await supabaseAdmin
      .from('lease_agreements')
      .update({
        pdf_storage_path: storagePath,
        pdf_drive_file_id: driveResult.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', lease_id)

    return NextResponse.json({ ok: true, driveFileId: driveResult.id, storagePath })
  } catch (err) {
    console.error('[regen-lease-pdf]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
