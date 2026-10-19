'use server'

import { safeAction, type ActionResult } from '@/lib/server-action'

/**
 * Validate that the account's Drive folder is accessible and has standard subfolders.
 */
export async function validateFolder(accountId: string): Promise<ActionResult<{
  valid: boolean
  folderId: string
  subfolders: string[]
  missingSubfolders: string[]
  fileCount: number
}>> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    const { listFolderAnyDrive } = await import('@/lib/google-drive')

    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('drive_folder_id')
      .eq('id', accountId)
      .single()

    if (!account?.drive_folder_id) throw new Error('No Drive folder linked to this account')

    const folderContents = await listFolderAnyDrive(account.drive_folder_id) as { files?: { id: string; name: string; mimeType: string }[] }
    if (!folderContents?.files) throw new Error('Could not access Drive folder — it may have been deleted or permissions changed')

    const items = folderContents.files
    const existingSubfolders = items
      .filter(f => f.mimeType === 'application/vnd.google-apps.folder')
      .map(f => f.name)
    const fileCount = items.filter(f => f.mimeType !== 'application/vnd.google-apps.folder').length

    const expected = ['1. Company', '2. Contacts', '3. Tax', '4. Banking', '5. Correspondence']
    const missingSubfolders = expected.filter(name => !existingSubfolders.includes(name))

    return {
      valid: missingSubfolders.length === 0,
      folderId: account.drive_folder_id,
      subfolders: existingSubfolders,
      missingSubfolders,
      fileCount,
    }
  }, {
    action_type: 'update',
    table_name: 'accounts',
    record_id: accountId,
    summary: 'Validated Drive folder',
  })
}

/**
 * Search Google Drive for folders matching a company name under a state parent.
 */
export async function searchDriveFolders(companyName: string, _state: string): Promise<ActionResult<Array<{
  id: string
  name: string
  createdTime: string
  fileCount: number
}>>> {
  return safeAction(async () => {
    const { searchFiles } = await import('@/lib/google-drive')

    const results = await searchFiles(companyName, 'application/vnd.google-apps.folder', 10) as Array<{
      id: string
      name: string
      createdTime?: string
      modifiedTime?: string
    }>

    // Return matching folders with metadata
    return results.map(f => ({
      id: f.id,
      name: f.name,
      createdTime: f.createdTime || f.modifiedTime || '',
      fileCount: 0, // Would need a separate listFolder call per result — skip for search speed
    }))
  }, {
    action_type: 'update',
    table_name: 'accounts',
    summary: `Searched Drive folders for "${companyName}"`,
  })
}
