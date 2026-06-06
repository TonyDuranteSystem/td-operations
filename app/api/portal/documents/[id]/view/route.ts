import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId } from '@/lib/portal-auth'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { recordDocumentView } from '@/lib/portal/document-alerts'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/portal/documents/[id]/view
 * Records that the requesting contact opened a document, clearing its "New"
 * state for them. Idempotent. Called by the document list when a client previews
 * or downloads a doc (the download proxy also records as a backstop).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const contactId = getClientContactId(user)
  // Per-person "new" state is contact-scoped; teammates have no contact id.
  if (!contactId) return NextResponse.json({ ok: true })

  const { data: doc } = await supabaseAdmin
    .from('documents')
    .select('id, account_id, contact_id')
    .eq('id', params.id)
    .single()
  if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 })

  // Default-deny access check, mirroring the download route.
  const hasAccountAccess = doc.account_id ? await canAccessAccount(user, doc.account_id, 'documents') : false
  const hasContactAccess = !doc.account_id && doc.contact_id === contactId
  if (!hasAccountAccess && !hasContactAccess) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  await recordDocumentView(doc.id, contactId)
  return NextResponse.json({ ok: true })
}
