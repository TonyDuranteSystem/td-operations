import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { moveFile, listFolder } from '@/lib/google-drive'
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
 * Body: { fileId: string, targetFolderId: string, targetFolderName?: string, preserveCategory?: boolean }
 *
 * preserveCategory: skip the category sync below. Needed by the guided-share
 * "file this in the right folder" step (dev job following ece21c44) — that
 * step runs on a document already confirmed personal (category 2) with a
 * resolved owner; syncing category to the destination folder would silently
 * turn that off (isUnresolvedPersonalDocument checks category === 2), letting
 * an already-resolved personal document look unresolved-personal-free to any
 * future check with no owner actually re-verified. The manual drag-and-drop /
 * "Move to..." menu (this route's original caller) is unaffected — it never
 * passes this flag, so its category-sync behavior is unchanged.
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

  const { fileId, targetFolderId, targetFolderName, preserveCategory } = await request.json()
  if (!fileId || !targetFolderId) {
    return NextResponse.json({ error: 'fileId and targetFolderId required' }, { status: 400 })
  }

  try {
    // Verify targetFolderId actually belongs to THIS account's own Drive
    // folder tree before moving anything. The guided-share "file it" step
    // (dev job dfc00bcf) supplies this id from a client-side fetch keyed by
    // account_id, fired on demand per document — without a server-side check
    // here, any client-side bug that ever sends a mismatched account/folder
    // pair (a stale request, a copy-paste error in a future change, direct
    // API misuse) would silently move a client's document into an unrelated
    // client's Drive folder and report success. Guarding at this write choke
    // point, not just in the caller, is the same lesson ece21c44 already
    // taught for the visibility guard.
    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('drive_folder_id')
      .eq('id', accountId)
      .maybeSingle()
    if (!account?.drive_folder_id) {
      return NextResponse.json({ error: 'This account has no Drive folder linked' }, { status: 400 })
    }
    const validFolderIds = new Set<string>([account.drive_folder_id])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rootResult = await listFolder(account.drive_folder_id, 100) as any
    const topFolders = ((rootResult?.files || []) as { id: string; mimeType: string }[])
      .filter(f => f.mimeType === 'application/vnd.google-apps.folder')
    for (const folder of topFolders) {
      validFolderIds.add(folder.id)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const subResult = await listFolder(folder.id, 100) as any
      for (const item of (subResult?.files || []) as { id: string; mimeType: string }[]) {
        if (item.mimeType === 'application/vnd.google-apps.folder') validFolderIds.add(item.id)
      }
    }
    if (!validFolderIds.has(targetFolderId)) {
      return NextResponse.json({ error: "That folder doesn't belong to this account" }, { status: 400 })
    }

    // Move on Drive
    const result = await moveFile(fileId, targetFolderId)

    // Update document category in Supabase if tracked
    if (targetFolderName && !preserveCategory) {
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
