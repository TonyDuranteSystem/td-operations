/**
 * GET /api/portal/correspondence/[id]/file
 * Download the file of one correspondence item that lives in the NEW CRM storage (Drive cutover, dev job ad09ea91).
 *
 * Access is checked on the CORRESPONDENCE ITEM — the same rule the list uses (the client's own contact, or any company
 * they can open) — not on a documents row. A correspondence file is not listed under Documents, so it has no
 * portal-visible documents row; this route is the only way a client reaches it. Drive-based items keep their Drive link.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId } from '@/lib/portal-auth'
import { isItemHiddenFromViewer } from '@/lib/portal/history-cutoff'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { parseStorePointer } from '@/lib/crm-store/document-pointer'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: item } = await supabaseAdmin
    .from('client_correspondence')
    .select('id, file_name, account_id, contact_id, drive_file_id, created_at')
    .eq('id', params.id)
    .maybeSingle()

  const fileId = parseStorePointer(item?.drive_file_id as string | null | undefined)
  if (!item || !fileId) return NextResponse.json({ error: 'File not found' }, { status: 404 })

  const contactId = getClientContactId(user)
  const ownContact = !!contactId && item.contact_id === contactId
  const companyAccess = item.account_id ? await canAccessAccount(user, item.account_id as string, 'documents') : false
  if (!ownContact && !companyAccess) return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  // A person who joined the company later cannot open a letter received before their start date (dev job d14e823f).
  if (!ownContact && await isItemHiddenFromViewer({ accountId: item.account_id as string | null, contactId, kind: 'correspondence', itemId: item.id as string, item: { created_at: item.created_at as string } })) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }

  try {
    const { readStoreFile, StoreFileUnavailableError } = await import('@/lib/crm-store/document-pointer')
    const { canPreviewInline } = await import('@/lib/crm-store/serve')
    let f
    try {
      f = await readStoreFile(fileId)
    } catch (e) {
      if (e instanceof StoreFileUnavailableError) return NextResponse.json({ error: 'File not found' }, { status: 404 })
      throw e
    }
    // stored bytes carry an uploader-chosen type (untrusted): only script-free types keep it
    const mimeType = canPreviewInline(f.mimeType) ? (f.mimeType as string) : 'application/octet-stream'
    return new NextResponse(new Uint8Array(f.bytes), {
      headers: {
        'X-Content-Type-Options': 'nosniff',
        'Content-Type': mimeType,
        'Content-Disposition': `attachment; filename="${encodeURIComponent((item.file_name as string) || f.name)}"`,
        'Content-Length': f.bytes.length.toString(),
      },
    })
  } catch (err) {
    console.error('[portal/correspondence/file]', err)
    return NextResponse.json({ error: 'Failed to download file' }, { status: 500 })
  }
}
