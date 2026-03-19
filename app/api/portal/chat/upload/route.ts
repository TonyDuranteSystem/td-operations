import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { NextRequest, NextResponse } from 'next/server'

const MAX_SIZE = 10 * 1024 * 1024 // 10MB
const ALLOWED_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
]

/**
 * POST /api/portal/chat/upload — Upload file attachment for chat
 * Body: multipart/form-data with file + account_id
 * Returns: { url, name } for attaching to a chat message
 */
export async function POST(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const formData = await request.formData()
  const file = formData.get('file') as File | null
  const accountId = formData.get('account_id') as string | null

  if (!file || !accountId) {
    return NextResponse.json({ error: 'file and account_id required' }, { status: 400 })
  }

  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: 'File too large (max 10MB)' }, { status: 400 })
  }

  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json({ error: 'File type not allowed. Use PDF, images, Word, Excel, or text files.' }, { status: 400 })
  }

  // Access control for client users
  const contactId = getClientContactId(user)
  if (contactId) {
    const accountIds = await getClientAccountIds(contactId)
    if (!accountIds.includes(accountId)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const ext = file.name.split('.').pop() || 'bin'
    const storagePath = `chat-attachments/${accountId}/${Date.now()}.${ext}`

    const { error: uploadError } = await supabaseAdmin.storage
      .from('public-assets')
      .upload(storagePath, buffer, {
        contentType: file.type,
        upsert: false,
      })

    if (uploadError) throw uploadError

    const { data: urlData } = supabaseAdmin.storage
      .from('public-assets')
      .getPublicUrl(storagePath)

    return NextResponse.json({
      url: urlData.publicUrl,
      name: file.name,
    })
  } catch (err) {
    console.error('Chat upload error:', err)
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
  }
}
