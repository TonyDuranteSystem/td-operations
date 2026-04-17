import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { processFile } from '@/lib/mcp/tools/doc'
import { createPortalNotification } from '@/lib/portal/notifications'
import { updateDocument } from '@/lib/operations/document'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * POST /api/accounts/[id]/files/process-and-share
 * Processes an unprocessed Drive file (OCR + classify) and sets portal_visible = true.
 * Sends a portal notification so the client gets an email via digest cron.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: accountId } = await params

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  const { fileId } = await request.json()
  if (!fileId) {
    return NextResponse.json({ error: 'fileId is required' }, { status: 400 })
  }

  // Get account info
  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name')
    .eq('id', accountId)
    .single()

  if (!account) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  }

  try {
    // Step 1: Process the file (OCR + classify + upsert to documents table)
    const result = await processFile(fileId, accountId, account.company_name)

    if (!result.success) {
      return NextResponse.json({ error: result.error || 'Failed to process file' }, { status: 500 })
    }

    // Step 2: Find the document record and set portal_visible = true
    const { data: doc } = await supabaseAdmin
      .from('documents')
      .select('id, file_name, account_id, contact_id')
      .eq('drive_file_id', fileId)
      .single()

    if (!doc) {
      return NextResponse.json({ error: 'Document record not found after processing' }, { status: 500 })
    }

    await updateDocument({
      id: doc.id,
      patch: { portal_visible: true },
      actor: `dashboard:${user.email ?? 'staff'}`,
      summary: 'Portal visibility enabled (process-and-share)',
    })

    // Step 3: Send portal notification
    await createPortalNotification({
      account_id: doc.account_id || undefined,
      contact_id: doc.contact_id || undefined,
      type: 'document',
      title: 'New document available',
      body: doc.file_name || 'A new document has been shared with you',
      link: '/portal/documents',
    })

    return NextResponse.json({
      success: true,
      docId: doc.id,
      portalVisible: true,
      fileName: result.fileName,
      type: result.type,
    })
  } catch (err) {
    console.error('[process-and-share] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Processing failed' },
      { status: 500 }
    )
  }
}
