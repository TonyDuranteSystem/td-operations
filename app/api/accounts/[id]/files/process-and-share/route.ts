import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { processFile } from '@/lib/mcp/tools/doc'
import { updateDocument } from '@/lib/operations/document'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * POST /api/accounts/[id]/files/process-and-share
 * Processes an unprocessed Drive file (OCR + classify) and sets portal_visible = true.
 *
 * Client alerting is NOT done here: updateDocument() fires the new-document
 * alert (notification + push + chat + "New" badge, idempotent) on the actual
 * hidden→visible transition — same choke point as every other share path.
 *
 * OCR-outage behavior (2026-06-11): if a prior processing attempt failed
 * (status='error', e.g. Document AI down or page limit), the share still goes
 * through — the client getting the document matters more than classification —
 * but the record KEEPS its honest error status and a document_reprocess job is
 * queued so OCR/classification self-heals when the backend recovers. Never
 * relabel an unprocessed document 'classified'.
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
    // Step 1: Check if a document record already exists (e.g., a prior OCR
    // attempt that failed). If so, skip OCR here — share immediately and let
    // the reprocess job heal classification in the background.
    const { data: existingDoc } = await supabaseAdmin
      .from('documents')
      .select('id, file_name, status, account_id, contact_id')
      .eq('drive_file_id', fileId)
      .maybeSingle()

    if (existingDoc) {
      const patch: Record<string, unknown> = { portal_visible: true }
      if (!existingDoc.account_id) {
        patch.account_id = accountId
        patch.account_name = account.company_name
      }

      const updateResult = await updateDocument({
        id: existingDoc.id,
        patch,
        actor: `dashboard:${user.email ?? 'staff'}`,
        summary: existingDoc.status === 'error'
          ? 'Portal visibility enabled (existing record — reprocess queued)'
          : 'Portal visibility enabled (existing record)',
      })

      if (!updateResult.success) {
        return NextResponse.json({ error: 'Failed to update document visibility' }, { status: 500 })
      }

      // Failed prior processing → queue background OCR/classify retry.
      if (existingDoc.status === 'error') {
        await enqueueReprocess(existingDoc.id, fileId, accountId)
      }

      return NextResponse.json({
        success: true,
        docId: existingDoc.id,
        portalVisible: true,
        fileName: existingDoc.file_name,
        type: 'existing',
        reprocessQueued: existingDoc.status === 'error',
      })
    }

    // Step 2: No existing record — process the file (OCR + classify + upsert)
    const result = await processFile(fileId, accountId, account.company_name)

    if (!result.success) {
      return NextResponse.json({ error: result.error || 'Failed to process file' }, { status: 500 })
    }

    // Step 3: Find the document record and set portal_visible = true.
    // updateDocument fires the client alert on the hidden→visible transition.
    const { data: doc } = await supabaseAdmin
      .from('documents')
      .select('id, file_name')
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

/**
 * Queue a document_reprocess job unless one is already pending/processing for
 * this document (a second toggle click must not double-queue). Best-effort:
 * a queue failure must not fail the share.
 */
async function enqueueReprocess(documentId: string, driveFileId: string, accountId: string) {
  try {
    const { data: existing } = await supabaseAdmin
      .from('job_queue')
      .select('id')
      .eq('job_type', 'document_reprocess')
      .eq('related_entity_id', documentId)
      .in('status', ['pending', 'processing'])
      .limit(1)

    if (existing && existing.length > 0) return

    const { enqueueJob } = await import('@/lib/jobs/queue')
    await enqueueJob({
      job_type: 'document_reprocess',
      payload: { document_id: documentId, drive_file_id: driveFileId, account_id: accountId },
      account_id: accountId,
      related_entity_type: 'document',
      related_entity_id: documentId,
      // Outage-friendly: 12 attempts ≈ an hour of 5-min cron retries before
      // giving up; longer outages are caught by the daily OCR health check.
      max_attempts: 12,
      created_by: 'process-and-share',
    })
  } catch (e) {
    console.warn('[process-and-share] reprocess enqueue failed:', e instanceof Error ? e.message : String(e))
  }
}
