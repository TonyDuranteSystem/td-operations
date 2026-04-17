import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { renameFile } from '@/lib/google-drive'
import { updateDocument } from '@/lib/operations/document'
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
    await updateDocument({
      drive_file_id: fileId,
      account_id: accountId,
      patch: { file_name: newName.trim() },
      actor: `dashboard:${user.email ?? 'staff'}`,
      summary: 'File renamed',
      details: { newName: newName.trim() },
    })

    return NextResponse.json({ success: true, file: result })
  } catch (err) {
    console.error('[files/rename] Error:', err)
    return NextResponse.json({ error: 'Failed to rename file' }, { status: 500 })
  }
}
