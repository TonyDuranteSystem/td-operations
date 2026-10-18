import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { canAccessAccount } from '@/lib/portal/team/gate'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { NextRequest, NextResponse } from 'next/server'
import { PERSONAL_CATEGORY } from '@/lib/documents/visibility-guard'
import { getClientContactId } from '@/lib/portal-auth'
import { NO_STORAGE_SENTENCE, NO_STORAGE_STATUS } from '@/lib/crm-store/no-storage'

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
    fileBuffer = Buffer.from(await file.arrayBuffer())
  }

  // Access control — default-deny (contacts AND teammates; never skipped).
  if (!(await canAccessAccount(user, accountId, 'documents'))) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  // Auto-classify (worked out first: the storage route below needs them too)
  const categoryNum = category ? parseInt(category) : 5
  const typeName = taxYear
    ? `${docType || 'Tax Document'} - ${taxYear}`
    : docType || 'Client Upload'

  // Every upload is saved in the company's CRM storage (Stop Drive, dev job 264bb882). A company with no storage
  // gets one plain sentence back — nothing else is tried.
  let stored: { documentRowId: string } | null = null
  try {
    const { saveDocumentForAccount, CompanyMovingError } = await import('@/lib/crm-store/save-for-account')
    const { createHash } = await import('crypto')
    const uploaderContactId = getClientContactId(user)
    let person: { contactId: string; name: string } | null = null
    if (categoryNum === PERSONAL_CATEGORY && uploaderContactId) {
      // a personal document (passport / ID) belongs to the member who uploaded it, in THEIR own storage
      const { data: c } = await supabaseAdmin.from('contacts').select('full_name').eq('id', uploaderContactId).maybeSingle()
      person = { contactId: uploaderContactId, name: (c?.full_name as string | undefined) || 'Member' }
    }
    const folder = categoryNum === 1 ? 'company' : categoryNum === 3 ? 'tax' : categoryNum === 4 ? 'banking' : categoryNum === PERSONAL_CATEGORY ? 'contacts' : 'correspondence'
    try {
      const routed = await saveDocumentForAccount({
        // a client's own upload stays HIDDEN until staff review it (same as on a Drive company, where portal_visible defaults to false) — but it
        // carries the generic client type, so the day staff choose "show to client" it opens (an untyped stored file is closed to clients)
        accountId, name: fileName, bytes: fileBuffer, mimeType: mimeType || null, folder, documentType: 'other_document',
        // the same file uploaded twice is ONE stored file
        callerKey: `portal-upload:${accountId}:${person ? person.contactId : 'company'}:${categoryNum}:${createHash('sha256').update(fileBuffer).digest('hex')}`,
        person,
        row: { category: categoryNum, document_type_name: typeName, status: 'classified' },
      })
      if (routed.route === 'store') stored = { documentRowId: routed.documentRowId }
    } catch (e) {
      if (e instanceof CompanyMovingError) return NextResponse.json({ error: e.message }, { status: 409 })
      throw e
    }
  } catch (err) {
    console.error('Upload error (storage route):', err)
    return NextResponse.json({ error: 'Upload failed. Please try again.' }, { status: 500 })
  }

  if (!stored) return NextResponse.json({ error: NO_STORAGE_SENTENCE }, { status: NO_STORAGE_STATUS })

  try {
    const docId = stored.documentRowId

    // Clean up Supabase Storage (async, don't block response)
    if (storagePath) {
      supabaseAdmin.storage.from('portal-uploads').remove([storagePath]).catch(() => {})
    }

    // Surface a Documents-topic system message in portal-chats so staff sees
    // a red unread dot the moment the client uploads. Non-fatal + idempotent
    // on documents.id (re-runs of webhook retries dedup).
    try {
      const { emitDocumentUploadedEvent } = await import('@/lib/portal/chat-events')
      const { getClientContactId } = await import('@/lib/portal-auth')
      await emitDocumentUploadedEvent({
        document_id: docId,
        // Tag the authenticated uploader so the note reaches their person
        // thread's What's New feed too (2026-07-06 fix). Staff uploads have
        // no client contact → stays account-only, as before.
        contact_id: getClientContactId(user),
        account_id: accountId,
        file_name: fileName,
        document_type_name: typeName,
      })
    } catch (e) {
      console.warn('[documents/upload] non-fatal portal-chat emit failure:', e instanceof Error ? e.message : String(e))
    }

    // For tax documents: create task + notification
    if (taxYear || categoryNum === 3) {
      // eslint-disable-next-line no-restricted-syntax -- pre-existing tax-doc task insert; left in place
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
      document_id: docId,
      file_name: fileName,
    })
  } catch (err) {
    console.error('Upload error:', err)
    return NextResponse.json({ error: 'Upload failed. Please try again.' }, { status: 500 })
  }
}
