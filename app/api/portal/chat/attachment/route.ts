import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId } from '@/lib/portal-auth'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/portal/chat/attachment?path=chat-attachments/<dir>/<file>
 *
 * Access-controlled proxy for chat attachments. Streams the bytes from storage
 * through the server (service key) AFTER verifying the caller may access the
 * thread the attachment belongs to — so a leaked/guessed URL is no longer enough
 * to download the file (security audit 2026-06-13, H6).
 *
 * Path shape mirrors the uploader (`chat/upload-url`):
 *   chat-attachments/<accountId|contactId>/<randomUUID>.<ext>
 * The <dir> segment is the account_id (account-scoped thread) or contact_id
 * (contact-only thread); access is checked against both.
 *
 * ⚠️ This proxy works whether the `assets` bucket is public or private. It is
 * the prerequisite for making the bucket private — see
 * docs/SECURITY-chat-attachments-cutover.md for the remaining infra steps
 * (flip bucket to private, migrate stored URLs to this proxy).
 */
export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const path = request.nextUrl.searchParams.get('path')?.trim() ?? ''
  // Only allow chat attachment paths; reject traversal / other buckets prefixes.
  if (!path.startsWith('chat-attachments/') || path.includes('..')) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
  }

  const segments = path.split('/')
  // chat-attachments / <dir> / <file>
  if (segments.length < 3 || !segments[1]) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
  }
  const dir = segments[1]

  // ─── Access control (mirrors chat/upload-url) ───
  let allowed = false
  if (isDashboardUser(user)) {
    allowed = true // staff/admin can view any thread
  } else if (await canAccessAccount(user, dir, 'chat')) {
    allowed = true // dir is an account the contact/teammate can access
  } else {
    const authContactId = getClientContactId(user)
    if (authContactId && dir === authContactId) allowed = true // own contact thread
  }

  if (!allowed) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const { data: blob, error } = await supabaseAdmin.storage.from('assets').download(path)
  if (error || !blob) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const arrayBuffer = await blob.arrayBuffer()
  const contentType = blob.type || 'application/octet-stream'

  return new NextResponse(arrayBuffer, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': 'inline',
      // Private: never let a shared CDN/cache serve this without re-auth.
      'Cache-Control': 'private, no-store',
    },
  })
}
