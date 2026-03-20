import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'

/**
 * POST /api/portal/documents/upload-url
 * Generates a signed upload URL for Supabase Storage.
 * Client uploads directly to Storage (bypasses Vercel 4.5MB limit).
 * Returns { signedUrl, path, token } for the client to upload to.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { account_id, file_name } = await request.json()
  if (!account_id || !file_name) {
    return NextResponse.json({ error: 'account_id and file_name required' }, { status: 400 })
  }

  // Access control
  const contactId = getClientContactId(user)
  if (contactId) {
    const accountIds = await getClientAccountIds(contactId)
    if (!accountIds.includes(account_id)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  // Generate unique path
  const ext = file_name.split('.').pop()?.toLowerCase() || 'pdf'
  const storagePath = `${account_id}/${randomUUID()}.${ext}`

  // Create signed upload URL (valid for 10 minutes)
  const { data, error } = await supabaseAdmin.storage
    .from('portal-uploads')
    .createSignedUploadUrl(storagePath)

  if (error) {
    console.error('Signed URL error:', error)
    return NextResponse.json({ error: 'Failed to generate upload URL' }, { status: 500 })
  }

  return NextResponse.json({
    signedUrl: data.signedUrl,
    path: storagePath,
    token: data.token,
  })
}
