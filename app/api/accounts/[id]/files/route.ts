import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { listFolder } from '@/lib/google-drive'
import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

interface DriveFile {
  id: string
  name: string
  mimeType: string
  size?: string
  modifiedTime?: string
  webViewLink?: string
}

interface FolderWithFiles {
  id: string
  name: string
  files: DriveFile[]
  subfolders: FolderWithFiles[]
}

/**
 * GET /api/accounts/[id]/files
 * Lists the client's Google Drive folder tree with all files.
 * Returns folders (1. Company, 2. Contacts, etc.) with their contents.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: accountId } = await params

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  // Get account's drive folder
  const { data: account, error } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name, drive_folder_id')
    .eq('id', accountId)
    .single()

  if (error || !account) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 })
  }

  if (!account.drive_folder_id) {
    return NextResponse.json({ error: 'No Drive folder linked to this account', folders: [], rootFiles: [] }, { status: 200 })
  }

  try {
    // List root folder contents
    const rootResult = await listFolder(account.drive_folder_id, 100)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rootItems: DriveFile[] = (rootResult as any)?.files || []

    const folders: FolderWithFiles[] = []
    const rootFiles: DriveFile[] = []

    // Separate folders from files
    const folderItems = rootItems.filter(f => f.mimeType === 'application/vnd.google-apps.folder')
    const fileItems = rootItems.filter(f => f.mimeType !== 'application/vnd.google-apps.folder')
    rootFiles.push(...fileItems)

    // Sort folders by name (1. Company, 2. Contacts, etc.)
    folderItems.sort((a, b) => a.name.localeCompare(b.name))

    // For each folder, list its contents (including subfolders)
    for (const folder of folderItems) {
      const folderResult = await listFolder(folder.id, 100)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const folderFiles: DriveFile[] = (folderResult as any)?.files || []

      const subfolders: FolderWithFiles[] = []
      const files: DriveFile[] = []

      for (const item of folderFiles) {
        if (item.mimeType === 'application/vnd.google-apps.folder') {
          // One level of subfolders (e.g., Tax/2025/)
          const subResult = await listFolder(item.id, 100)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const subFiles: DriveFile[] = ((subResult as any)?.files || [])
            .filter((f: DriveFile) => f.mimeType !== 'application/vnd.google-apps.folder')
          subfolders.push({ id: item.id, name: item.name, files: subFiles, subfolders: [] })
        } else {
          files.push(item)
        }
      }

      // Sort subfolders and files by name
      subfolders.sort((a, b) => b.name.localeCompare(a.name)) // year folders: newest first
      files.sort((a, b) => a.name.localeCompare(b.name))

      folders.push({ id: folder.id, name: folder.name, files, subfolders })
    }

    // Fetch document records from Supabase to get portal_visible + document IDs
    const { data: docs } = await supabaseAdmin
      .from('documents')
      .select('id, drive_file_id, portal_visible')
      .eq('account_id', accountId)

    // Build a map: drive_file_id -> { docId, portal_visible }
    const docMap = new Map<string, { docId: string; portalVisible: boolean }>()
    for (const doc of docs || []) {
      if (doc.drive_file_id) {
        docMap.set(doc.drive_file_id, { docId: doc.id, portalVisible: doc.portal_visible ?? false })
      }
    }

    return NextResponse.json({ folders, rootFiles, docMap: Object.fromEntries(docMap) })
  } catch (err) {
    console.error('[files] Error listing Drive folder:', err)
    return NextResponse.json({ error: 'Failed to list Drive folder' }, { status: 500 })
  }
}
