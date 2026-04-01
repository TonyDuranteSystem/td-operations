import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { renameFile } from '@/lib/google-drive'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/accounts/[id]/files/rename
 * Rename a file on Google Drive. Also updates documents table if tracked.
 * Body: { fileId: string, newName: string }
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

  const { fileId, newName } = await request.json()
  if (!fileId || !newName?.trim()) {
    return NextResponse.json({ error: 'fileId and newName required' }, { status: 400 })
  }

  try {
    // Rename on Drive
    const result = await renameFile(fileId, newName.trim())

    // Update documents table if this file is tracked
    await supabaseAdmin
      .from('documents')
      .update({ file_name: newName.trim() })
      .eq('drive_file_id', fileId)
      .eq('account_id', accountId)

    return NextResponse.json({ success: true, file: result })
  } catch (err) {
    console.error('[files/rename] Error:', err)
    return NextResponse.json({ error: 'Failed to rename file' }, { status: 500 })
  }
}
