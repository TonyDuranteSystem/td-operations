import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId } from '@/lib/portal-auth'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'

/**
 * POST /api/portal/chat/upload-url
 * Returns a short-lived signed upload URL so the browser uploads the file
 * DIRECTLY to Supabase Storage — bypassing the serverless request-body limit
 * that capped the old streaming route (see lib/portal/chat-attachment.ts).
 *
 * Body: { account_id?, contact_id?, file_name }
 * Returns: { signedUrl, token, path, publicUrl }
 *
 * Access control mirrors POST /api/portal/chat (the message send route):
 *   - staff/admin (role !== 'client')          → allowed (any thread)
 *   - teammate (client role, no contact id)     → only their own account, 'chat' granted
 *   - client contact                            → only their linked accounts / own contact thread
 *
 * The file lands in the PUBLIC `assets` bucket under chat-attachments/<dir>/,
 * keeping the same path shape the chat send route validates and the UI renders.
 * Type/size policy is enforced client-side (validateChatAttachment) and the
 * 100MB ceiling at the bucket's file_size_limit.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const accountId: string | null = body.account_id || null
  const contactId: string | null = body.contact_id || null
  const fileName: string | null = typeof body.file_name === 'string' ? body.file_name : null

  if (!accountId && !contactId) {
    return NextResponse.json({ error: 'account_id or contact_id required' }, { status: 400 })
  }
  if (!fileName) {
    return NextResponse.json({ error: 'file_name required' }, { status: 400 })
  }

  // Access control — same branching as the chat send route.
  const isClientUser = (user.app_metadata as Record<string, unknown> | undefined)?.role === 'client'
  const authContactId = getClientContactId(user)

  if (accountId) {
    // canAccessAccount handles all three identities (admin passthrough,
    // contact membership, teammate-with-capability).
    if (!(await canAccessAccount(user, accountId, 'chat'))) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  } else {
    // Contact-only thread (no account). Teammates always post WITH an account,
    // so a client user here must be a contact posting to their own thread.
    if (isClientUser) {
      if (!authContactId || (contactId && contactId !== authContactId)) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 })
      }
    }
    // Staff/admin: allowed.
  }

  // Build the storage path. Keep chat-attachments/<dir>/ so existing rendering
  // and the send route's attachment_url validation keep working. Random file
  // name — never user-controlled bytes in the path.
  const ext = (fileName.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin'
  const dir = accountId || contactId || 'unknown'
  const storagePath = `chat-attachments/${dir}/${randomUUID()}.${ext}`

  const { data, error } = await supabaseAdmin.storage
    .from('assets')
    .createSignedUploadUrl(storagePath)

  if (error || !data) {
    console.error('Chat signed-URL error:', error)
    return NextResponse.json({ error: 'Could not start the upload. Please try again.' }, { status: 500 })
  }

  const { data: urlData } = supabaseAdmin.storage.from('assets').getPublicUrl(storagePath)

  return NextResponse.json({
    signedUrl: data.signedUrl,
    token: data.token,
    path: storagePath,
    publicUrl: urlData.publicUrl,
  })
}
