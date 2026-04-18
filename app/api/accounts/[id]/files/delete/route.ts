import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { trashFile } from '@/lib/google-drive'
import { logAction } from '@/lib/mcp/action-log'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/accounts/[id]/files/delete
 * Soft-delete a file on Google Drive (moves to trash, recoverable 30 days).
 * Also removes the document record from Supabase if tracked.
 * Body: { fileId: string }
 *
 * P3.7: every delete logs to action_log with dashboard:<user> actor.
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
    return NextResponse.json({ error: 'fileId required' }, { status: 400 })
  }

  try {
    // Capture the tracked document row (if any) before deleting it so the
    // audit entry has a useful file_name + document_id.
    const { data: docRow } = await supabaseAdmin
      .from('documents')
      .select('id, file_name, document_type_name, contact_id')
      .eq('drive_file_id', fileId)
      .eq('account_id', accountId)
      .maybeSingle()

    // Trash on Drive (soft delete — recoverable 30 days)
    const trashed = await trashFile(fileId)
    const fileName = docRow?.file_name || trashed?.name || fileId

    // Remove from documents table if tracked
    const { count } = await supabaseAdmin
      .from('documents')
      .delete({ count: 'exact' })
      .eq('drive_file_id', fileId)
      .eq('account_id', accountId)

    logAction({
      actor: `dashboard:${user.email?.split('@')[0] ?? 'unknown'}`,
      action_type: 'delete',
      table_name: 'documents',
      record_id: docRow?.id || fileId,
      account_id: accountId,
      summary: `Trashed file: ${fileName}`,
      details: {
        drive_file_id: fileId,
        file_name: fileName,
        document_type: docRow?.document_type_name ?? null,
        document_row_deleted: count ?? 0,
        recoverable_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      },
    })

    return NextResponse.json({ success: true, fileName })
  } catch (err) {
    console.error('[files/delete] Error:', err)
    return NextResponse.json({ error: 'Failed to delete file' }, { status: 500 })
  }
}
