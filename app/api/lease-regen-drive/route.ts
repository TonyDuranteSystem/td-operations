import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { NO_STORAGE_STATUS, noStorageDecisionFor } from '@/lib/crm-store/no-storage'

export async function POST(req: NextRequest) {
  try {
    // ⛔ STAFF ONLY. This files a PDF into a client's storage + publishes it to their
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

    // The signed lease goes to the company's storage — the same file key as the original signing, so this is a new
    // VERSION of that file, never a copy. A company with no storage gets one plain sentence back.
    {
      const regenFileData = Buffer.from(await blob.arrayBuffer())
      const { saveSignedPdfForAccount, CompanyMovingError } = await import('@/lib/crm-store/save-for-account')
      let routed
      try {
      routed = await saveSignedPdfForAccount({
        accountId: lease.account_id,
        fileName: `Lease Agreement - ${lease.tenant_company} (Suite ${lease.suite_number}, Signed).pdf`,
        bytes: regenFileData, label: 'Lease Agreement', category: 1, callerKey: `lease-signed:${lease.id}`, documentType: 'office_lease',
      })
      } catch (e) {
        // a company that is being moved: a clean "try again", never a 500
        if (e instanceof CompanyMovingError) return NextResponse.json({ error: e.message }, { status: 409 })
        // a signed original takes no new version (the writer saves a changed copy as a replacement file); anything else gets plain words
        const { plainStoreError } = await import('@/lib/crm-store/lock-errors')
        console.error('[lease-regen-drive] store save failed:', e)
        return NextResponse.json({ error: plainStoreError(e, 'The lease could not be saved in the company storage. Please try again.') }, { status: 500 })
      }
      if (routed.route === 'store') return NextResponse.json({ ok: true, driveFileId: routed.pointer })
    }

    // No storage: Stop Drive S2 — nothing is ever written to Drive, so the company gets one plain sentence with the true reason.
    const decision = await noStorageDecisionFor(lease.account_id)
    return NextResponse.json({ error: decision.sentence }, { status: NO_STORAGE_STATUS })
  } catch (err) {
    console.error('[lease-regen-drive]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
