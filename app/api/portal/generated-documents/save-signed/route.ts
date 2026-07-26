import { createClient } from '@/lib/supabase/server'
import { getClientContactId, getClientAccountIds } from '@/lib/portal-auth'
import { checkRateLimit, getRateLimitKey } from '@/lib/portal/rate-limit'
import { saveSignedGeneratedDocument } from '@/lib/portal/save-generated-document'
import { reportSystemError } from '@/lib/system-errors'
import { NextRequest, NextResponse } from 'next/server'

const ROUTE = '/api/portal/generated-documents/save-signed'

/**
 * POST /api/portal/generated-documents/save-signed  (multipart/form-data)
 *
 * Persists a document the client generated AND SIGNED themselves into their
 * portal Documents folder. Fields: file (the signed PDF), account_id,
 * document_type, file_name. Surfaces the file for the client; alerts only
 * co-owners, never the maker (see saveSignedGeneratedDocument).
 */
export async function POST(request: NextRequest) {
  const rl = checkRateLimit(getRateLimitKey(request), 10, 60_000)
  if (!rl.allowed) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const contactId = getClientContactId(user)
  if (!contactId) return NextResponse.json({ error: 'No contact linked' }, { status: 403 })

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 })
  }

  const file = form.get('file') as File | null
  const accountId = form.get('account_id') as string | null
  const documentType = (form.get('document_type') as string | null) || 'Generated Document'
  const documentTypeKey = (form.get('document_type_key') as string | null) || ''
  const fileName = (form.get('file_name') as string | null) || (file?.name ?? 'document.pdf')
  // Tax statements file under Tax (3); everything else self-signed is Company (1).
  const category = documentTypeKey === 'tax_statement' ? 3 : 1

  if (!file || !accountId) {
    return NextResponse.json({ error: 'file and account_id are required' }, { status: 400 })
  }
  // Guard against oversized bodies (generated certificates are small).
  if (file.size > 8 * 1024 * 1024) {
    return NextResponse.json({ error: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB) — max 8 MB.` }, { status: 400 })
  }

  // The client may only save into their own account.
  const accountIds = await getClientAccountIds(contactId)
  if (!accountIds.includes(accountId)) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 })
  }

  const fileBuffer = Buffer.from(await file.arrayBuffer())

  const result = await saveSignedGeneratedDocument({
    accountId,
    contactId,
    fileBuffer,
    fileName,
    documentType,
    category,
    mimeType: file.type || 'application/pdf',
  })

  if (!result.success) {
    // The client's download already succeeded, so this failure is otherwise
    // invisible — record it so ops sees when a signed doc didn't reach the
    // portal folder (Drive outage, missing folder, insert failure).
    await reportSystemError({
      source: 'server',
      route: ROUTE,
      method: 'POST',
      http_status: 500,
      user_email: user.email ?? null,
      message: `Signed generated document failed to save to portal: ${result.error}`,
      context: { account_id: accountId, file_name: fileName, drive_file_id: result.driveFileId ?? null },
    }).catch(() => {})
    return NextResponse.json({ error: result.error || 'Failed to save document' }, { status: 500 })
  }

  return NextResponse.json({ document_id: result.documentId, co_owners_alerted: result.coOwnersAlerted })
}
