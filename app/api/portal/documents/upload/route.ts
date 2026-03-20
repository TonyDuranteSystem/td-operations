import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { NextRequest, NextResponse } from 'next/server'
import { uploadBinaryToDrive } from '@/lib/google-drive'

const MAX_SIZE = 4 * 1024 * 1024 // 4MB (Vercel serverless limit is 4.5MB)
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
 * Client selects document type (Passport, Tax Return, etc.) — system auto-classifies
 * into the correct category (1=Company, 2=Contacts, 3=Tax, 4=Banking, 5=Correspondence).
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
  const docType = formData.get('doc_type') as string | null     // e.g. "Passport", "Tax Return"
  const category = formData.get('category') as string | null     // auto-mapped: 1-5
  const taxYear = formData.get('tax_year') as string | null      // only for tax doc uploads

  if (!file || !accountId) {
    return NextResponse.json({ error: 'file and account_id required' }, { status: 400 })
  }

  // Size check
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: 'File too large (max 4MB)' }, { status: 400 })
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

    // Auto-classify based on client's document type selection
    const categoryNum = category ? parseInt(category) : 5
    const typeName = taxYear
      ? `${docType || 'Tax Document'} - ${taxYear}`
      : docType || 'Client Upload'

    const { data: doc, error: insertError } = await supabaseAdmin
      .from('documents')
      .insert({
        file_name: file.name,
        drive_file_id: driveFile.id,
        account_id: accountId,
        category: categoryNum,
        document_type_name: typeName,
        status: 'classified',
        confidence: '1.0',
        mime_type: file.type,
        file_size: file.size,
      })
      .select('id')
      .single()

    if (insertError) {
      console.error('Document insert error:', insertError)
      return NextResponse.json({ error: 'File uploaded to Drive but failed to save record. Please contact support.' }, { status: 500 })
    }

    // For tax documents: create task + notification for admin
    if (taxYear || categoryNum === 3) {
      await supabaseAdmin.from('tasks').insert({
        task_title: `Review tax document: ${file.name}${taxYear ? ` (${taxYear})` : ''}`,
        assigned_to: 'Luca',
        category: 'Document',
        account_id: accountId,
        status: 'To Do',
        priority: 'Normal',
        description: `Client uploaded ${typeName}: ${file.name} via portal.`,
      })

      await supabaseAdmin.from('portal_notifications').insert({
        account_id: accountId,
        type: 'tax_document_uploaded',
        title: `Tax document uploaded${taxYear ? ` for ${taxYear}` : ''}`,
        body: `${file.name} (${typeName}) uploaded via portal`,
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
