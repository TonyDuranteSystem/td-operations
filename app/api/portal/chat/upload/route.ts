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

// File magic byte signatures for validation
const MAGIC_BYTES: Record<string, number[][]> = {
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]], // %PDF
  'image/jpeg': [[0xFF, 0xD8, 0xFF]],
  'image/png': [[0x89, 0x50, 0x4E, 0x47]],
  'image/gif': [[0x47, 0x49, 0x46, 0x38]], // GIF8
  'image/webp': [], // RIFF-based, check separately
  'application/msword': [[0xD0, 0xCF, 0x11, 0xE0]], // OLE2
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [[0x50, 0x4B, 0x03, 0x04]], // PK (ZIP)
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [[0x50, 0x4B, 0x03, 0x04]], // PK (ZIP)
}

function validateMagicBytes(buffer: Buffer, mimeType: string): boolean {
  const signatures = MAGIC_BYTES[mimeType]
  // Text files and CSV don't have magic bytes — skip check
  if (!signatures || signatures.length === 0) return true
  return signatures.some(sig =>
    sig.every((byte, i) => buffer[i] === byte)
  )
}

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

    // Validate file content matches claimed MIME type (magic bytes check)
    if (!validateMagicBytes(buffer, file.type)) {
      return NextResponse.json({ error: 'File content does not match declared type' }, { status: 400 })
    }

    // Sanitize extension — only allow safe extensions
    const SAFE_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'doc', 'docx', 'xlsx', 'txt', 'csv']
    const rawExt = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '')
    const ext = SAFE_EXTENSIONS.includes(rawExt) ? rawExt : 'bin'
    // Use random filename — never user-controlled names in storage path
    const storagePath = `chat-attachments/${accountId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`

    const { error: uploadError } = await supabaseAdmin.storage
      .from('assets')
      .upload(storagePath, buffer, {
        contentType: file.type,
        upsert: false,
      })

    if (uploadError) throw uploadError

    const { data: urlData } = supabaseAdmin.storage
      .from('assets')
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
