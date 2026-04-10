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

/**
 * Process a Drive file and create a document record for this contact.
 * After processing, the file appears in the document list with OCR button.
 * If the file is a passport/ITIN/EIN, also runs extraction OCR.
 */
export async function processContactFile(contactId: string, driveFileId: string, fileName: string): Promise<ActionResult<{ documentId?: string }>> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')

    // Check if already processed
    const { data: existing } = await supabaseAdmin
      .from('documents')
      .select('id')
      .eq('drive_file_id', driveFileId)
      .maybeSingle()

    if (existing) {
      return { documentId: existing.id }
    }

    // Get contact's linked account for account_id resolution
    const { data: links } = await supabaseAdmin
      .from('account_contacts')
      .select('account_id, accounts:account_id(company_name)')
      .eq('contact_id', contactId)
      .limit(1)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const link = links?.[0] as any
    const accountId = link?.account_id || null
    const accountName = link?.accounts?.company_name || null

    // Process via the existing processFile function
    const { processFile } = await import('@/lib/mcp/tools/doc')
    const result = await processFile(driveFileId, accountId, accountName, contactId)

    if (!result.success) {
      throw new Error(`Processing failed: ${result.error || 'Unknown error'}`)
    }

    // Look up the created document record
    const { data: createdDoc } = await supabaseAdmin
      .from('documents')
      .select('id, document_type_name')
      .eq('drive_file_id', driveFileId)
      .maybeSingle()

    // If passport/ITIN/EIN — trigger OCR extraction
    const docType = (createdDoc?.document_type_name || result.type || fileName || '').toLowerCase()
    if (/passport|itin|ein/.test(docType) && createdDoc?.id) {
      try {
        const { ocrDriveFile } = await import('@/lib/docai')
        const ocrResult = await ocrDriveFile(driveFileId)

        if (ocrResult.fullText) {
          if (docType.includes('passport')) {
            const { parsePassportFromOcr } = await import('@/lib/passport-processing')
            const parsed = parsePassportFromOcr(ocrResult.fullText)
            const updates: Record<string, unknown> = { passport_on_file: true, updated_at: new Date().toISOString() }
            if (parsed.passportNumber) updates.passport_number = parsed.passportNumber
            if (parsed.expiryDate) updates.passport_expiry_date = parsed.expiryDate
            if (parsed.dateOfBirth) updates.date_of_birth = parsed.dateOfBirth
            await supabaseAdmin.from('contacts').update(updates).eq('id', contactId)
          } else if (docType.includes('itin')) {
            const itinMatch = ocrResult.fullText.match(/\b(9\d{2}[- ]?\d{2}[- ]?\d{4})\b/)
            if (itinMatch) {
              const formatted = itinMatch[1].replace(/[- ]/g, '').replace(/(\d{3})(\d{2})(\d{4})/, '$1-$2-$3')
              await supabaseAdmin.from('contacts').update({ itin_number: formatted, updated_at: new Date().toISOString() }).eq('id', contactId)
            }
          }
        }
      } catch (ocrErr) {
        console.warn('[processContactFile] OCR extraction failed (non-fatal):', ocrErr)
      }
    }

    revalidatePath(`/contacts/${contactId}`)
    return { documentId: createdDoc?.id }
  }, {
    action_type: 'create',
    table_name: 'documents',
    record_id: contactId,
    summary: `Processed Drive file ${fileName} for contact`,
  })
}

/**
 * ONE-TIME REPAIR: Fix contacts whose drive_folder_id points to company root
 * instead of the company's "2. Contacts" subfolder.
 * Processes all affected contacts, resolves the correct subfolder via Drive API.
 * Returns a report of updated, skipped, and errored contacts.
 */
export async function repairContactFolderLinks(): Promise<ActionResult<{
  updated: number
  skipped: Array<{ contactId: string; contactName: string; companyName: string; reason: string }>
  errors: Array<{ contactId: string; contactName: string; error: string }>
}>> {
  return safeAction(async () => {
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    const { listFolderAnyDrive } = await import('@/lib/google-drive')

    // Find all contacts pointing to company root
    const { data: rows } = await supabaseAdmin
      .from('contacts')
      .select(`
        id, first_name, last_name, drive_folder_id,
        account_contacts!inner(account_id, accounts!inner(id, company_name, drive_folder_id))
      `)
      .not('drive_folder_id', 'is', null)

    if (!rows || rows.length === 0) return { updated: 0, skipped: [], errors: [] }

    // Filter to contacts where drive_folder_id = company drive_folder_id
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const affected = rows.filter((r: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const links = r.account_contacts as any[]
      return links?.some((l: { accounts: { drive_folder_id: string | null } }) =>
        l.accounts?.drive_folder_id && l.accounts.drive_folder_id === r.drive_folder_id
      )
    })

    // Cache: company_root_id -> "2. Contacts" subfolder ID (or null)
    const subfolderCache = new Map<string, string | null>()

    let updated = 0
    const skipped: Array<{ contactId: string; contactName: string; companyName: string; reason: string }> = []
    const errors: Array<{ contactId: string; contactName: string; error: string }> = []

    for (const row of affected) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = row as any
      const contactName = [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Unknown'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const link = (r.account_contacts as any[])?.[0]
      const companyName = link?.accounts?.company_name || 'Unknown'
      const companyRootId = link?.accounts?.drive_folder_id as string

      if (!companyRootId) {
        skipped.push({ contactId: r.id, contactName, companyName, reason: 'No company folder' })
        continue
      }

      try {
        // Resolve "2. Contacts" subfolder (cached per company)
        if (!subfolderCache.has(companyRootId)) {
          const result = await listFolderAnyDrive(companyRootId) as { files?: { id: string; name: string; mimeType: string }[] }
          const items = result?.files || []
          const contactsFolders = items.filter(
            (f: { name: string; mimeType: string }) => f.name === '2. Contacts' && f.mimeType === 'application/vnd.google-apps.folder'
          )

          if (contactsFolders.length === 1) {
            subfolderCache.set(companyRootId, contactsFolders[0].id)
          } else if (contactsFolders.length === 0) {
            subfolderCache.set(companyRootId, null)
          } else {
            // Multiple "2. Contacts" folders — ambiguous
            subfolderCache.set(companyRootId, null)
            skipped.push({ contactId: r.id, contactName, companyName, reason: `Multiple "2. Contacts" subfolders (${contactsFolders.length})` })
            continue
          }
        }

        const contactsSubfolderId = subfolderCache.get(companyRootId)
        if (!contactsSubfolderId) {
          skipped.push({ contactId: r.id, contactName, companyName, reason: 'No "2. Contacts" subfolder found' })
          continue
        }

        // Update the contact
        const { error: updateErr } = await supabaseAdmin
          .from('contacts')
          .update({
            drive_folder_id: contactsSubfolderId,
            gdrive_folder_url: `https://drive.google.com/drive/folders/${contactsSubfolderId}`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', r.id)
          .eq('drive_folder_id', companyRootId) // Safety: only if still pointing to company root

        if (updateErr) {
          errors.push({ contactId: r.id, contactName, error: updateErr.message })
        } else {
          updated++
        }
      } catch (err) {
        errors.push({ contactId: r.id, contactName, error: err instanceof Error ? err.message : String(err) })
      }
    }

    return { updated, skipped, errors }
  }, {
    action_type: 'update',
    table_name: 'contacts',
    summary: 'Batch repair: contact folder links (company root → 2. Contacts subfolder)',
  })
}
