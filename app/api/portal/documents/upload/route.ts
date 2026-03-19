import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { NextRequest, NextResponse } from 'next/server'
import { uploadBinaryToDrive } from '@/lib/google-drive'

const MAX_SIZE = 10 * 1024 * 1024 // 10MB
const ALLOWED_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]

/**
 * POST /api/portal/documents/upload
 * Uploads a file to the client's Google Drive folder.
 * Body: multipart/form-data with file + account_id + category
 */
export async function POST(request: NextRequest) {
  // Rate limit: 10 uploads per minute per IP
  const rl = checkRateLimit(getRateLimitKey(request), 10, 60_000)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many uploads. Try again later.' }, { status: 429 })

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const formData = await request.formData()
  const file = formData.get('file') as File | null
  const accountId = formData.get('account_id') as string | null
  const category = formData.get('category') as string | null
  const taxYear = formData.get('tax_year') as string | null
  const docType = formData.get('doc_type') as string | null

  if (!file || !accountId) {
    return NextResponse.json({ error: 'file and account_id required' }, { status: 400 })
  }

  // Size check
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: 'File too large (max 10MB)' }, { status: 400 })
  }

  // Type check
  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json({ error: 'File type not allowed. Use PDF, JPEG, PNG, or DOCX.' }, { status: 400 })
  }

  // Access control
  const contactId = getClientContactId(user)
  if (contactId) {
    const accountIds = await getClientAccountIds(contactId)
    if (!accountIds.includes(accountId)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }
  }

  // Get account's Drive folder
  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('drive_folder_id, company_name')
    .eq('id', accountId)
    .single()

  if (!account?.drive_folder_id) {
    return NextResponse.json({ error: 'No Drive folder configured for this account. Please contact support.' }, { status: 400 })
  }

  try {
    // Upload to Google Drive
    const buffer = Buffer.from(await file.arrayBuffer())
    const driveFile = await uploadBinaryToDrive(
      file.name,
      buffer,
      file.type,
      account.drive_folder_id
    )

    // Record in documents table
    const categoryNum = category ? parseInt(category) : 5 // Default: Correspondence
    const typeName = taxYear
      ? `${docType || 'Tax Document'} - ${taxYear}`
      : 'Client Upload'

    const { data: doc } = await supabaseAdmin
      .from('documents')
      .insert({
        file_name: file.name,
        drive_file_id: driveFile.id,
        account_id: accountId,
        category: categoryNum,
        document_type_name: typeName,
        status: 'classified',
        confidence: 1.0,
      })
      .select('id')
      .single()

    // For tax documents: create task + notification for admin
    if (taxYear) {
      await supabaseAdmin.from('tasks').insert({
        task_title: `Review tax document: ${file.name} (${taxYear})`,
        assigned_to: 'Luca',
        category: 'Document',
        account_id: accountId,
        status: 'To Do',
        priority: 'Normal',
        description: `Client uploaded ${file.name} (${docType || 'Tax Document'}) for tax year ${taxYear} via portal.`,
      })

      await supabaseAdmin.from('portal_notifications').insert({
        account_id: accountId,
        type: 'tax_document_uploaded',
        title: `Tax document uploaded for ${taxYear}`,
        body: `${file.name} uploaded for tax year ${taxYear}`,
      })
    }

    return NextResponse.json({
      success: true,
      document_id: doc?.id,
      file_name: file.name,
    })
  } catch (err) {
    console.error('Upload error:', err)
    return NextResponse.json({ error: 'Upload failed. Please try again.' }, { status: 500 })
  }
}
