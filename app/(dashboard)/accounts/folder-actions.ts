'use server'

import { revalidatePath } from 'next/cache'
import { safeAction, type ActionResult } from '@/lib/server-action'

/**
 * Create a company folder in Google Drive and link it to the account.
 * Uses ensureCompanyFolder() which includes Drive-side dedup.
 */
export async function createCompanyFolder(accountId: string): Promise<ActionResult<{ folderId: string }>> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    const { ensureCompanyFolder } = await import('@/lib/drive-folder-utils')

    // Get account info for folder naming
    const { data: account, error } = await supabaseAdmin
      .from('accounts')
      .select('company_name, state_of_formation, drive_folder_id')
      .eq('id', accountId)
      .single()

    if (error || !account) throw new Error('Account not found')
    if (account.drive_folder_id) throw new Error(`Account already has a Drive folder: ${account.drive_folder_id}`)
    if (!account.company_name) throw new Error('Account has no company name')
    if (!account.state_of_formation) throw new Error('Account has no state of formation')

    // Primary contact, for naming the Drive folder. Resolved through `account_contacts`:
    // `contacts` has NO `account_id` column, so filtering on one errored, the error was
    // discarded with the row set, and the owner name silently came back empty — every
    // folder was named without it. Third instance of the same defect found on 2026-07-20;
    // a repo-wide test now blocks the shape.
    const { data: link } = await supabaseAdmin
      .from('account_contacts')
      .select('contact_id')
      .eq('account_id', accountId)
      .limit(1)
      .maybeSingle()

    let ownerName: string | undefined
    if (link?.contact_id) {
      const { data: contact } = await supabaseAdmin
        .from('contacts')
        .select('first_name, last_name')
        .eq('id', link.contact_id)
        .maybeSingle()
      const name = [contact?.first_name, contact?.last_name].filter(Boolean).join(' ')
      ownerName = name || undefined
    }

    const result = await ensureCompanyFolder(
      accountId,
      account.company_name,
      account.state_of_formation,
      ownerName,
    )

    revalidatePath(`/accounts/${accountId}`)
    return { folderId: result.folderId }
  }, {
    action_type: 'create',
    table_name: 'accounts',
    record_id: accountId,
    summary: 'Created company Drive folder',
  })
}

/**
 * Link an existing Google Drive folder to the account.
 */
export async function linkDriveFolder(accountId: string, driveFolderId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    const { listFolderAnyDrive } = await import('@/lib/google-drive')

    // Verify the folder exists and is accessible
    const folderContents = await listFolderAnyDrive(driveFolderId) as { files?: { id: string; name: string; mimeType: string }[] }
    if (!folderContents?.files) throw new Error('Could not access Drive folder — check the folder ID')

    // Update account
    // PRE-EXISTING write, untouched by the contact-lookup fix in this file. Routing it
    // through lib/operations is a real refactor with its own risk and belongs in its own
    // change, not smuggled into a bug fix.
    // eslint-disable-next-line no-restricted-syntax
    const { error } = await supabaseAdmin
      .from('accounts')
      .update({
        drive_folder_id: driveFolderId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', accountId)

    if (error) throw new Error(`Failed to update account: ${error.message}`)

    revalidatePath(`/accounts/${accountId}`)
  }, {
    action_type: 'update',
    table_name: 'accounts',
    record_id: accountId,
    summary: `Linked Drive folder ${driveFolderId}`,
  })
}

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
