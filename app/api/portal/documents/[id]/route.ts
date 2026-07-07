import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { downloadFileBinary } from '@/lib/google-drive'
import { getClientContactId } from '@/lib/portal-auth'
import { canAccessAccount } from '@/lib/portal/team/gate'
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
  // Default-deny (never skipped for a null contact id, e.g. a teammate).
  // Account-scoped docs: gated by the 'documents' capability + account match.
  // Contact-scoped (personal) docs: ONLY the owning contact — never a teammate.
  const contactId = getClientContactId(user)
  const hasAccountAccess = doc.account_id ? await canAccessAccount(user, doc.account_id, 'documents') : false
  const hasContactAccess = !doc.account_id && !!contactId && doc.contact_id === contactId
  if (!hasAccountAccess && !hasContactAccess) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  // Record that this contact opened the document (clears its "New" state for
  // them). Backstop for the client-side view ping; contact users only —
  // teammates have no contact id and don't carry per-person "new" state.
  if (contactId) {
    const { recordDocumentView } = await import('@/lib/portal/document-alerts')
    recordDocumentView(doc.id, contactId).catch(() => {})
  }

  // Download and stream to client. Flow uploads on contact-scoped SDs live in
  // Supabase Storage under a synthetic `storage:<path>` id (same shape the
  // staff preview route handles) — e.g. an ITIN approval letter. Everything
  // else streams from Google Drive.
  try {
    let buffer: Buffer
    let mimeType: string | null = null
    let fileName: string | null = null

    if (doc.drive_file_id.startsWith('storage:')) {
      const path = doc.drive_file_id.slice('storage:'.length)
      const { data, error: dlErr } = await supabaseAdmin.storage
        .from('onboarding-uploads')
        .download(path)
      if (dlErr || !data) {
        return NextResponse.json({ error: 'Document file not found' }, { status: 404 })
      }
      buffer = Buffer.from(await data.arrayBuffer())
      mimeType = data.type || null
    } else {
      const drive = await downloadFileBinary(doc.drive_file_id)
      buffer = drive.buffer
      mimeType = drive.mimeType
      fileName = drive.fileName
    }

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
