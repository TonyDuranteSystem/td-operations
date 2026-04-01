import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { trashFile } from '@/lib/google-drive'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/accounts/[id]/files/delete
 * Soft-delete a file on Google Drive (moves to trash, recoverable 30 days).
 * Also removes the document record from Supabase if tracked.
 * Body: { fileId: string }
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
    // Trash on Drive (soft delete — recoverable 30 days)
    await trashFile(fileId)

    // Remove from documents table if tracked
    await supabaseAdmin
      .from('documents')
      .delete()
      .eq('drive_file_id', fileId)
      .eq('account_id', accountId)

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[files/delete] Error:', err)
    return NextResponse.json({ error: 'Failed to delete file' }, { status: 500 })
  }
}
