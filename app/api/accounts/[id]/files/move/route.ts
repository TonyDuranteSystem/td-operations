import { createClient } from '@/lib/supabase/server'
import { isDashboardUser } from '@/lib/auth'
import { moveFile } from '@/lib/google-drive'
import { updateDocument } from '@/lib/operations/document'
import { NextRequest, NextResponse } from 'next/server'

// Map folder names to document categories
const FOLDER_TO_CATEGORY: Record<string, number> = {
  '1. Company': 1,
  '2. Contacts': 2,
  '3. Tax': 3,
  '4. Banking': 4,
  '5. Correspondence': 5,
}

/**
 * POST /api/accounts/[id]/files/move
 * Move a file to a different folder on Google Drive.
 * Also updates the document category in Supabase if tracked.
 * Body: { fileId: string, targetFolderId: string, targetFolderName?: string }
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

  const { fileId, targetFolderId, targetFolderName } = await request.json()
  if (!fileId || !targetFolderId) {
    return NextResponse.json({ error: 'fileId and targetFolderId required' }, { status: 400 })
  }

  try {
    // Move on Drive
    const result = await moveFile(fileId, targetFolderId)

    // Update document category in Supabase if tracked
    if (targetFolderName) {
      const newCategory = FOLDER_TO_CATEGORY[targetFolderName]
      if (newCategory) {
        const categoryNames: Record<number, string> = {
          1: 'Company', 2: 'Contacts', 3: 'Tax', 4: 'Banking', 5: 'Correspondence',
        }
        await updateDocument({
          drive_file_id: fileId,
          account_id: accountId,
          patch: { category: newCategory, category_name: categoryNames[newCategory] },
          actor: `dashboard:${user.email ?? 'staff'}`,
          summary: `File moved to ${targetFolderName}`,
          details: { targetFolderName, newCategory },
        })
      }
    }

    return NextResponse.json({ success: true, file: result })
  } catch (err) {
    console.error('[files/move] Error:', err)
    return NextResponse.json({ error: 'Failed to move file' }, { status: 500 })
  }
}
