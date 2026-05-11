import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { downloadFileBinary } from '@/lib/google-drive'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/portal/documents/[id]
 * Proxy download — streams file from Google Drive.
 * Verifies the requesting user owns the account the document belongs to.
 * NEVER exposes Drive file IDs or URLs to the client.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  // Auth check
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get the document
  const { data: doc } = await supabaseAdmin
    .from('documents')
    .select('id, file_name, account_id, contact_id, drive_file_id')
    .eq('id', params.id)
    .single()

  if (!doc || !doc.drive_file_id) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 })
  }

  // Verify access — allow if EITHER (a) the document belongs to one of the
  // contact's accounts, OR (b) the document is contact-scoped (no account_id)
  // and the contact_id matches the requester. Contact-scoped documents exist
  // for pure contact-only ITIN clients (Phase B, 2026-05-11).
  const contactId = getClientContactId(user)
  if (contactId) {
    const accountIds = await getClientAccountIds(contactId)
    const hasAccountAccess = doc.account_id && accountIds.includes(doc.account_id)
    const hasContactAccess = !doc.account_id && doc.contact_id === contactId
    if (!hasAccountAccess && !hasContactAccess) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  // Download from Drive and stream to client
  try {
    const { buffer, mimeType, fileName } = await downloadFileBinary(doc.drive_file_id)

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': mimeType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName || doc.file_name)}"`,
        'Content-Length': buffer.length.toString(),
      },
    })
  } catch (error) {
    console.error('Document download error:', error)
    return NextResponse.json({ error: 'Failed to download document' }, { status: 500 })
  }
}
