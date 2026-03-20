import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { NextRequest, NextResponse } from 'next/server'
import { uploadBinaryToDrive } from '@/lib/google-drive'

/**
 * POST /api/portal/documents/upload
 * Two modes:
 * 1. storage_path mode (new): File already in Supabase Storage, just process it.
 *    Body JSON: { account_id, storage_path, file_name, mime_type, file_size, doc_type, category, tax_year? }
 * 2. Direct upload mode (legacy/small files <4MB):
 *    Body: multipart/form-data with file + account_id + doc_type + category
 */
export async function POST(request: NextRequest) {
  const rl = checkRateLimit(getRateLimitKey(request), 10, 60_000)
  if (!rl.allowed) return NextResponse.json({ error: 'Too many uploads. Try again later.' }, { status: 429 })

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const contentType = request.headers.get('content-type') || ''

  let accountId: string
  let fileName: string
  let mimeType: string
  let fileSize: number
  let fileBuffer: Buffer
  let docType: string | null = null
  let category: string | null = null
  let taxYear: string | null = null
  let storagePath: string | null = null

  if (contentType.includes('application/json')) {
    // Mode 1: File is in Supabase Storage
    const body = await request.json()
    accountId = body.account_id
    storagePath = body.storage_path
    fileName = body.file_name
    mimeType = body.mime_type || 'application/pdf'
    fileSize = body.file_size || 0
    docType = body.doc_type
    category = body.category
    taxYear = body.tax_year

    if (!accountId || !storagePath || !fileName) {
      return NextResponse.json({ error: 'account_id, storage_path, and file_name required' }, { status: 400 })
    }

    // Download from Supabase Storage
    const { data: storageData, error: downloadError } = await supabaseAdmin.storage
      .from('portal-uploads')
      .download(storagePath)

    if (downloadError || !storageData) {
      console.error('Storage download error:', downloadError)
      return NextResponse.json({ error: 'Failed to retrieve uploaded file' }, { status: 500 })
    }

    fileBuffer = Buffer.from(await storageData.arrayBuffer())
  } else {
    // Mode 2: Direct multipart upload (small files)
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    accountId = formData.get('account_id') as string ?? ''
    docType = formData.get('doc_type') as string | null
    category = formData.get('category') as string | null
    taxYear = formData.get('tax_year') as string | null

    if (!file || !accountId) {
      return NextResponse.json({ error: 'file and account_id required' }, { status: 400 })
    }

    const MAX_DIRECT = 4 * 1024 * 1024
    if (file.size > MAX_DIRECT) {
      return NextResponse.json({ error: 'File too large for direct upload. Use the storage upload flow.' }, { status: 400 })
    }

    fileName = file.name
    mimeType = file.type
    fileSize = file.size
    fileBuffer = Buffer.from(await file.arrayBuffer())
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
    const driveFile = await uploadBinaryToDrive(
      fileName,
      fileBuffer,
      mimeType,
      account.drive_folder_id
    )

    // Auto-classify
    const categoryNum = category ? parseInt(category) : 5
    const typeName = taxYear
      ? `${docType || 'Tax Document'} - ${taxYear}`
      : docType || 'Client Upload'

    const { data: doc, error: insertError } = await supabaseAdmin
      .from('documents')
      .insert({
        file_name: fileName,
        drive_file_id: driveFile.id,
        account_id: accountId,
        category: categoryNum,
        document_type_name: typeName,
        status: 'classified',
        confidence: 'high',
        mime_type: mimeType,
        file_size: fileSize,
      })
      .select('id')
      .single()

    if (insertError) {
      console.error('Document insert error:', insertError)
      return NextResponse.json({ error: 'File uploaded to Drive but failed to save record. Please contact support.' }, { status: 500 })
    }

    // Clean up Supabase Storage (async, don't block response)
    if (storagePath) {
      supabaseAdmin.storage.from('portal-uploads').remove([storagePath]).catch(() => {})
    }

    // For tax documents: create task + notification
    if (taxYear || categoryNum === 3) {
      await supabaseAdmin.from('tasks').insert({
        task_title: `Review tax document: ${fileName}${taxYear ? ` (${taxYear})` : ''}`,
        assigned_to: 'Luca',
        category: 'Document',
        account_id: accountId,
        status: 'To Do',
        priority: 'Normal',
        description: `Client uploaded ${typeName}: ${fileName} via portal.`,
      })

      await supabaseAdmin.from('portal_notifications').insert({
        account_id: accountId,
        type: 'tax_document_uploaded',
        title: `Tax document uploaded${taxYear ? ` for ${taxYear}` : ''}`,
        body: `${fileName} (${typeName}) uploaded via portal`,
      })
    }

    // Audit log
    const { logPortalAction } = await import('@/lib/portal/audit')
    logPortalAction({
      user_id: user.id,
      account_id: accountId,
      action: taxYear ? 'tax_doc_uploaded' : 'document_uploaded',
      detail: `${fileName} (${typeName || 'general'})`,
      ip: request.headers.get('x-forwarded-for') || undefined,
    })

    return NextResponse.json({
      success: true,
      document_id: doc?.id,
      file_name: fileName,
    })
  } catch (err) {
    console.error('Upload error:', err)
    return NextResponse.json({ error: 'Upload failed. Please try again.' }, { status: 500 })
  }
}
