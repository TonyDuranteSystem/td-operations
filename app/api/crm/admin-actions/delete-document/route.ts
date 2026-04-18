/**
 * POST /api/crm/admin-actions/delete-document
 *
 * Admin-only. Deletes a document: removes from documents table + trashes on
 * Google Drive. Soft delete — file recoverable from Drive trash within 30
 * days. The DB row is hard-deleted.
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

    let driveTrashed = false

    // Trash on Google Drive (soft delete — recoverable from trash)
    if (doc.drive_file_id) {
      try {
        const { trashFile } = await import('@/lib/google-drive')
        await trashFile(doc.drive_file_id)
        driveTrashed = true
      } catch (driveErr) {
        // Drive deletion is best-effort — continue with DB deletion
        console.warn(`[delete-document] Drive trash failed for ${doc.drive_file_id}:`, driveErr)
      }
    }

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
        drive_trashed: driveTrashed,
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
