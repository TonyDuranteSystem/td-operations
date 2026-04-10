import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { listFolder } from '@/lib/google-drive'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

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
 * GET /api/contacts/[id]/files
 * Lists the contact's Google Drive folder tree with all files.
 * Same pattern as /api/accounts/[id]/files but reads contacts.drive_folder_id.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contactId } = await params

  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) {
    return NextResponse.json({ error: 'Dashboard access required' }, { status: 403 })
  }

  const { data: contact, error } = await supabaseAdmin
    .from('contacts')
    .select('id, first_name, last_name, drive_folder_id')
    .eq('id', contactId)
    .single()

  if (error || !contact) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
  }

  if (!contact.drive_folder_id) {
    return NextResponse.json({ error: 'No Drive folder linked to this contact', folders: [], rootFiles: [] }, { status: 200 })
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rootResult = await listFolder(contact.drive_folder_id, 100)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rootItems: DriveFile[] = (rootResult as any)?.files || []

    const folders: FolderWithFiles[] = []
    const rootFiles: DriveFile[] = []

    const folderItems = rootItems.filter(f => f.mimeType === 'application/vnd.google-apps.folder')
    const fileItems = rootItems.filter(f => f.mimeType !== 'application/vnd.google-apps.folder')
    rootFiles.push(...fileItems)

    folderItems.sort((a, b) => a.name.localeCompare(b.name))

    for (const folder of folderItems) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const folderResult = await listFolder(folder.id, 100)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const folderFiles: DriveFile[] = (folderResult as any)?.files || []

      const subfolders: FolderWithFiles[] = []
      const files: DriveFile[] = []

      for (const item of folderFiles) {
        if (item.mimeType === 'application/vnd.google-apps.folder') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const subResult = await listFolder(item.id, 100)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const subFiles: DriveFile[] = ((subResult as any)?.files || [])
            .filter((f: DriveFile) => f.mimeType !== 'application/vnd.google-apps.folder')
          subfolders.push({ id: item.id, name: item.name, files: subFiles, subfolders: [] })
        } else {
          files.push(item)
        }
      }

      subfolders.sort((a, b) => b.name.localeCompare(a.name))
      files.sort((a, b) => a.name.localeCompare(b.name))

      folders.push({ id: folder.id, name: folder.name, files, subfolders })
    }

    // Fetch document records for portal visibility
    const { data: docs } = await supabaseAdmin
      .from('documents')
      .select('id, drive_file_id, portal_visible')
      .eq('contact_id', contactId)

    const docMap = new Map<string, { docId: string; portalVisible: boolean }>()
    for (const doc of docs || []) {
      if (doc.drive_file_id) {
        docMap.set(doc.drive_file_id, { docId: doc.id, portalVisible: doc.portal_visible ?? false })
      }
    }

    return NextResponse.json({ folders, rootFiles, docMap: Object.fromEntries(docMap) })
  } catch (err) {
    console.error('[contact-files] Error listing Drive folder:', err)
    return NextResponse.json({ error: 'Failed to list Drive folder' }, { status: 500 })
  }
}
