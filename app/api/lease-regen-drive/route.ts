import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { autoSaveDocument } from '@/lib/portal/auto-save-document'

export async function POST(req: NextRequest) {
  try {
    // ⛔ STAFF ONLY. This files a PDF into a client's Drive + publishes it to their
    // portal, and it had NO auth at all — an anonymous caller could point it (via
    // the old client-supplied `pdf_path`) at any object in the signed-leases bucket
    // and inject it as the client's "signed lease". Its sibling regen-lease-pdf was
    // already gated this way; this one was missed. Real staff hold a dashboard
    // session (they open the admin regen while logged in); an attacker does not.
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user || !isDashboardUser(user)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { lease_id, token } = await req.json() as { lease_id: string; token: string }

    if (!lease_id || !token) {
      return NextResponse.json({ error: 'lease_id, token required' }, { status: 400 })
    }

    // Read the recorded signed PDF from the LEASE ROW, never a caller-supplied path.
    // The old `pdf_path` parameter let the caller name any bucket object; deriving
    // it server-side removes that vector entirely.
    const { data: lease } = await supabaseAdmin
      .from('lease_agreements')
      .select('id, token, tenant_company, account_id, suite_number, pdf_storage_path')
      .eq('id', lease_id)
      .eq('token', token)
      .single()

    if (!lease) return NextResponse.json({ error: 'Lease not found' }, { status: 404 })
    if (!lease.account_id) return NextResponse.json({ error: 'No account_id on lease' }, { status: 400 })
    if (!lease.pdf_storage_path) return NextResponse.json({ error: 'Lease has no signed PDF on file' }, { status: 400 })

    const { data: blob } = await supabaseAdmin.storage
      .from('signed-leases')
      .download(lease.pdf_storage_path)

    if (!blob) return NextResponse.json({ error: 'PDF not found in storage' }, { status: 404 })

    const { data: acct } = await supabaseAdmin
      .from('accounts')
      .select('drive_folder_id')
      .eq('id', lease.account_id)
      .single()

    if (!acct?.drive_folder_id) {
      return NextResponse.json({ error: 'Account has no Drive folder' }, { status: 400 })
    }

    const { listFolder, uploadBinaryToDriveUpsert } = await import('@/lib/google-drive')
    const folderResult = await listFolder(acct.drive_folder_id) as {
      files?: { id: string; name: string; mimeType: string }[]
    }
    const companyFolder = folderResult.files?.find(
      f => f.name.includes('Company') && f.mimeType === 'application/vnd.google-apps.folder'
    )
    const targetFolderId = companyFolder?.id || acct.drive_folder_id

    const arrayBuffer = await blob.arrayBuffer()
    const fileData = Buffer.from(arrayBuffer)
    const fileName = `Lease Agreement - ${lease.tenant_company} (Suite ${lease.suite_number}, Signed).pdf`

    // Stable name -> UPSERT: regeneration refreshes the one existing file in place (LT Program incident class).
    const driveResult = await uploadBinaryToDriveUpsert(
      fileName, fileData, 'application/pdf', targetFolderId
    ) as { id: string }

    await autoSaveDocument({
      accountId: lease.account_id,
      fileName,
      documentType: 'Lease Agreement',
      category: 1,
      driveFileId: driveResult.id,
      portalVisible: true,
    })

    return NextResponse.json({ ok: true, driveFileId: driveResult.id })
  } catch (err) {
    console.error('[lease-regen-drive]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
