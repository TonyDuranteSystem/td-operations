/**
 * POST /api/crm/admin-actions/delete-document
 *
 * Admin-only. Deletes a document: a CRM Storage file goes to the storage trash; a raw Google Drive record only loses its CRM
 * listing (Stop Drive S2: Drive is a read-only archive, the Drive file is never trashed). The DB row is hard-deleted.
 *
 * Body: { document_id }
 *
 * P3.7: routes through canPerform('delete_record') + logs to action_log
 * with dashboard:<user> actor.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { canPerform } from '@/lib/permissions'
import { logAction } from '@/lib/mcp/action-log'

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!canPerform(user, 'delete_record')) {
    return NextResponse.json({ success: false, detail: 'Admin access required' }, { status: 403 })
  }

  try {
    const { document_id } = await req.json()

    if (!document_id) {
      return NextResponse.json({ success: false, detail: 'Missing document_id' }, { status: 400 })
    }

    // Get document info before deleting
    const { data: doc } = await supabaseAdmin
      .from('documents')
      .select('id, file_name, drive_file_id, contact_id, account_id, document_type_name')
      .eq('id', document_id)
      .single()

    if (!doc) {
      return NextResponse.json({ success: false, detail: 'Document not found' }, { status: 404 })
    }

    // CRM Store files (pilot, sandbox only): the stored file goes to the STORE's trash (recoverable, legal
    // holds apply) and its CRM listing is removed — the same as the storage screen's Delete.
    const { parseStorePointer } = await import('@/lib/crm-store/document-pointer')
    const storeFileId = parseStorePointer(doc.drive_file_id)
    if (storeFileId) {
      try {
        const { deleteStoreFile } = await import('@/lib/crm-store/file-actions')
        await deleteStoreFile(storeFileId, user?.id ?? null)
      } catch (e) {
        return NextResponse.json({ success: false, detail: e instanceof Error ? e.message : 'The document could not be deleted.' }, { status: 400 })
      }
      logAction({
        actor: `dashboard:${user?.email?.split('@')[0] ?? 'unknown'}`,
        action_type: 'delete',
        table_name: 'documents',
        record_id: document_id,
        account_id: doc.account_id ?? undefined,
        summary: `Document moved to the CRM Storage trash: ${doc.file_name}`,
        details: { store_file_id: storeFileId, contact_id: doc.contact_id },
      })
      return NextResponse.json({ success: true, detail: `Moved to the trash (recoverable for 90 days): ${doc.file_name}` })
    }

    // Stop Drive S2: the Google Drive file (a raw archive record) is NEVER touched — only the CRM listing is removed.

    // Delete from documents table
    await supabaseAdmin
      .from('documents')
      .delete()
      .eq('id', document_id)

    logAction({
      actor: `dashboard:${user?.email?.split('@')[0] ?? 'unknown'}`,
      action_type: 'delete',
      table_name: 'documents',
      record_id: document_id,
      account_id: doc.account_id,
      contact_id: doc.contact_id,
      summary: `Document deleted: ${doc.file_name}`,
      details: {
        file_name: doc.file_name,
        drive_file_id: doc.drive_file_id,
        document_type: doc.document_type_name,
      },
    })

    return NextResponse.json({
      success: true,
      detail: `Deleted: ${doc.file_name}`,
    })
  } catch (e) {
    console.error('[delete-document] Error:', e)
    return NextResponse.json({ success: false, detail: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
