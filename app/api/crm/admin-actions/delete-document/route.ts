/**
 * Delete a document: removes from documents table + trashes on Google Drive.
 *
 * POST { document_id }
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase-admin'

export async function POST(req: NextRequest) {
  try {
    const { document_id } = await req.json()

    if (!document_id) {
      return NextResponse.json({ success: false, detail: 'Missing document_id' }, { status: 400 })
    }

    // Get document info before deleting
    const { data: doc } = await supabaseAdmin
      .from('documents')
      .select('id, file_name, drive_file_id, contact_id, account_id')
      .eq('id', document_id)
      .single()

    if (!doc) {
      return NextResponse.json({ success: false, detail: 'Document not found' }, { status: 404 })
    }

    // Trash on Google Drive (soft delete — recoverable from trash)
    if (doc.drive_file_id) {
      try {
        const { trashFile } = await import('@/lib/google-drive')
        await trashFile(doc.drive_file_id)
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

    // Log
    await supabaseAdmin.from('action_log').insert({
      actor: 'crm-admin',
      action_type: 'delete_document',
      table_name: 'documents',
      record_id: document_id,
      account_id: doc.account_id,
      summary: `Document deleted: ${doc.file_name}`,
      details: { file_name: doc.file_name, drive_file_id: doc.drive_file_id, contact_id: doc.contact_id },
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
