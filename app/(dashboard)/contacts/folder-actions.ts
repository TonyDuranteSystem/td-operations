'use server'

import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'

/**
 * Create a contact folder in Google Drive and link it to the contact.
 * Uses ensureContactFolder() which includes Drive-side dedup.
 */
export async function createContactFolder(contactId: string): Promise<ActionResult<{ folderId: string }>> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    const { ensureContactFolder } = await import('@/lib/drive-folder-utils')

    const { data: contact, error } = await supabaseAdmin
      .from('contacts')
      .select('first_name, last_name, drive_folder_id')
      .eq('id', contactId)
      .single()

    if (error || !contact) throw new Error('Contact not found')
    if (contact.drive_folder_id) throw new Error(`Contact already has a Drive folder: ${contact.drive_folder_id}`)

    const contactName = [contact.first_name, contact.last_name].filter(Boolean).join(' ')
    if (!contactName) throw new Error('Contact has no name')

    const result = await ensureContactFolder(contactId, contactName)

    revalidatePath(`/contacts/${contactId}`)
    return { folderId: result.folderId }
  }, {
    action_type: 'create',
    table_name: 'contacts',
    record_id: contactId,
    summary: 'Created contact Drive folder',
  })
}

/**
 * Link an existing Google Drive folder to the contact.
 */
export async function linkContactFolder(contactId: string, driveFolderId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    const { listFolderAnyDrive } = await import('@/lib/google-drive')

    const folderContents = await listFolderAnyDrive(driveFolderId) as { files?: { id: string; name: string; mimeType: string }[] }
    if (!folderContents?.files) throw new Error('Could not access Drive folder — check the folder ID')

    const { error } = await supabaseAdmin
      .from('contacts')
      .update({
        drive_folder_id: driveFolderId,
        gdrive_folder_url: `https://drive.google.com/drive/folders/${driveFolderId}`,
        updated_at: new Date().toISOString(),
      })
      .eq('id', contactId)

    if (error) throw new Error(`Failed to update contact: ${error.message}`)

    revalidatePath(`/contacts/${contactId}`)
  }, {
    action_type: 'update',
    table_name: 'contacts',
    record_id: contactId,
    summary: `Linked contact Drive folder ${driveFolderId}`,
  })
}

/**
 * Validate that the contact's Drive folder is accessible and has standard subfolders.
 */
export async function validateContactFolder(contactId: string): Promise<ActionResult<{
  valid: boolean
  folderId: string
  subfolders: string[]
  missingSubfolders: string[]
  fileCount: number
}>> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    const { listFolderAnyDrive } = await import('@/lib/google-drive')

    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('drive_folder_id')
      .eq('id', contactId)
      .single()

    if (!contact?.drive_folder_id) throw new Error('No Drive folder linked to this contact')

    const folderContents = await listFolderAnyDrive(contact.drive_folder_id) as { files?: { id: string; name: string; mimeType: string }[] }
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
      folderId: contact.drive_folder_id,
      subfolders: existingSubfolders,
      missingSubfolders,
      fileCount,
    }
  }, {
    action_type: 'update',
    table_name: 'contacts',
    record_id: contactId,
    summary: 'Validated contact Drive folder',
  })
}
