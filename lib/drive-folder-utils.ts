/**
 * Shared Google Drive folder creation utilities.
 *
 * Two-phase approach for formation clients:
 * Phase 1: ensureContactFolder() → Contacts/{Name}/ (pre-company)
 * Phase 2: ensureCompanyFolder() + migrateContactToCompany() (post-company)
 *
 * Used by:
 * - formation-setup.ts (Phase 1)
 * - onboarding-setup.ts (Phase 2 directly)
 * - select_llc_name API action (Phase 2 migration)
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

// ─── Drive folder IDs (Shared Drive: Tony Durante LLC) ────────────────────
const TD_CLIENTS_ROOT = '1mbz_bUDwC4K259RcC-tDKihjlvdAVXno'
const COMPANIES_ROOT = '1Z32I4pDzX4enwqJQzolbFw7fK94ISuCb'

// State-specific parent folders under Companies/
const STATE_FOLDER_MAP: Record<string, string> = {
  'New Mexico': '1tkJjg0HKbIl0uFzvK4zW3rtU14sdCHo4',
  'NM': '1tkJjg0HKbIl0uFzvK4zW3rtU14sdCHo4',
  'Wyoming': '110NUZZJC1mf3vKB12bmxfRFIVZJ3SE5x',
  'WY': '110NUZZJC1mf3vKB12bmxfRFIVZJ3SE5x',
  'Delaware': '1QoF8WZsW_TT-cXM9NxLeTN1ng1jqbZM-',
  'DE': '1QoF8WZsW_TT-cXM9NxLeTN1ng1jqbZM-',
  'Florida': '1XToxqPl-t6z10raeal_frSpvBBBRY8nG',
  'FL': '1XToxqPl-t6z10raeal_frSpvBBBRY8nG',
}

const STANDARD_SUBFOLDERS = [
  '1. Company',
  '2. Contacts',
  '3. Tax',
  '4. Banking',
  '5. Correspondence',
]

// Contacts root folder under TD Clients/ (created on first use)
let contactsRootId: string | null = null

// ─── Types ─────────────────────────────────────────────────────────────────
interface DriveItem { id: string; name: string; mimeType: string }

// ─── Helper: lazy import google-drive ──────────────────────────────────────
async function getDriveHelpers() {
  const { createFolder, listFolderAnyDrive, moveFile } = await import('@/lib/google-drive')
  // Wrap listFolderAnyDrive to return files array (it returns { files: [...] })
  const listFiles = async (folderId: string): Promise<DriveItem[]> => {
    const res = await listFolderAnyDrive(folderId)
    return (res as { files?: DriveItem[] }).files ?? []
  }
  return { createFolder, listFiles, moveFile }
}

// ─── Helper: self-heal standard subfolders on an already-linked folder ─────
// A folder we're about to reuse (already on file for a contact or account)
// may predate the standard structure, or may have lost a subfolder some
// other way. Callers depend on specific subfolder names (e.g. "2. Contacts"
// for passport filing) existing — silently trusting whatever's already
// there caused documents to fail filing with no visible error (dev_task:
// Turcanu/Tacoli passport investigation). This creates any standard
// subfolder that's missing, same as the brand-new-folder path already did.
async function ensureSubfoldersOn(folderId: string): Promise<Record<string, string>> {
  const { listFiles, createFolder } = await getDriveHelpers()
  const existingSubs = await listFiles(folderId)
  const existingSubMap: Record<string, string> = {}
  for (const f of existingSubs) {
    if (f.mimeType === 'application/vnd.google-apps.folder') {
      existingSubMap[f.name] = f.id
    }
  }
  const subfolders: Record<string, string> = { ...existingSubMap }
  for (const subName of STANDARD_SUBFOLDERS) {
    if (existingSubMap[subName]) continue
    try {
      const sub = await createFolder(folderId, subName) as { id: string }
      subfolders[subName] = sub.id
    } catch (err) {
      console.warn(`[drive-folder-utils] Failed to create subfolder ${subName}:`, err)
    }
  }
  return subfolders
}

// ─── Ensure Contacts root folder exists ───────────────────────────────────
async function ensureContactsRoot(): Promise<string> {
  if (contactsRootId) return contactsRootId

  const { listFiles, createFolder } = await getDriveHelpers()

  // Check if Contacts folder already exists under TD Clients
  const items = await listFiles(TD_CLIENTS_ROOT)
  const existing = items.find(
    f => f.name === 'Contacts' && f.mimeType === 'application/vnd.google-apps.folder',
  )

  if (existing) {
    contactsRootId = existing.id
    return existing.id
  }

  // Create it
  const folder = await createFolder(TD_CLIENTS_ROOT, 'Contacts') as { id: string }
  contactsRootId = folder.id
  return folder.id
}

// ─── Phase 1: Contact folder (pre-company) ─────────────────────────────────

export async function ensureContactFolder(
  contactId: string,
  contactName: string,
): Promise<{ folderId: string; created: boolean; subfolders: Record<string, string> }> {
  // A contact who already has a materialized company may have had
  // drive_folder_id repointed at the COMPANY's own "2. Contacts" leaf by
  // migrateContactToCompany() — a leaf folder, not a root with its own
  // subfolder tree. Resolve through the company's real folder in that case
  // instead of treating the leaf as a Phase-1 root and grafting a nested
  // "2. Contacts" folder inside it. service_deliveries is the durable link
  // (formation-materialize.ts writes account_id onto the contact's SD row).
  const { data: linkedSd } = await supabaseAdmin
    .from('service_deliveries')
    .select('account_id')
    .eq('contact_id', contactId)
    .not('account_id', 'is', null)
    .limit(1)
    .maybeSingle()

  if (linkedSd?.account_id) {
    const { data: account } = await supabaseAdmin
      .from('accounts')
      .select('drive_folder_id')
      .eq('id', linkedSd.account_id)
      .single()

    if (account?.drive_folder_id) {
      const subfolders = await ensureSubfoldersOn(account.drive_folder_id)
      return { folderId: account.drive_folder_id, created: false, subfolders }
    }
  }

  // Check if contact already has drive_folder_id or gdrive_folder_url
  const { data: contact } = await supabaseAdmin
    .from('contacts')
    .select('drive_folder_id, gdrive_folder_url')
    .eq('id', contactId)
    .single()

  // If contact already has a Drive folder ID, return it — self-healing any
  // standard subfolder that's missing (folder may predate the standard
  // structure, e.g. an old manually-created folder).
  if (contact?.drive_folder_id) {
    const subfolders = await ensureSubfoldersOn(contact.drive_folder_id)
    return { folderId: contact.drive_folder_id, created: false, subfolders }
  }

  // Legacy fallback: extract from gdrive_folder_url if drive_folder_id not set
  if (contact?.gdrive_folder_url) {
    const idMatch = (contact.gdrive_folder_url as string).match(/folders\/([a-zA-Z0-9_-]+)/)
    if (idMatch) {
      const existingId = idMatch[1]
      // Backfill drive_folder_id
      // eslint-disable-next-line no-restricted-syntax -- Drive-folder-link bookkeeping, not client-facing CRM data; central path
      await supabaseAdmin
        .from('contacts')
        .update({ drive_folder_id: existingId, updated_at: new Date().toISOString() })
        .eq('id', contactId)
      const subfolders = await ensureSubfoldersOn(existingId)
      return { folderId: existingId, created: false, subfolders }
    }
  }

  // No folder linked — check Drive for existing folder with same name (dedup)
  const rootId = await ensureContactsRoot()
  const { createFolder, listFiles } = await getDriveHelpers()

  const existingItems = await listFiles(rootId)
  const matches = existingItems.filter(
    f => f.name === contactName && f.mimeType === 'application/vnd.google-apps.folder',
  )

  let contactFolder: { id: string }
  if (matches.length === 1) {
    contactFolder = { id: matches[0].id }
    console.warn(`[drive-folder-utils] Found existing contact folder "${contactName}" (${matches[0].id}) — linking instead of creating`)
  } else if (matches.length > 1) {
    const ids = matches.map(m => m.id).join(', ')
    throw new Error(
      `Multiple Drive folders named "${contactName}" found (${ids}). ` +
      `Manual admin selection required — use "Link Existing Contact Folder" in the CRM.`
    )
  } else {
    contactFolder = await createFolder(rootId, contactName) as { id: string }
  }

  // Ensure standard subfolders exist
  const subfolders = await ensureSubfoldersOn(contactFolder.id)

  // Save both drive_folder_id and gdrive_folder_url to contact record
  // eslint-disable-next-line no-restricted-syntax -- Drive-folder-link bookkeeping, not client-facing CRM data; central path
  await supabaseAdmin
    .from('contacts')
    .update({
      drive_folder_id: contactFolder.id,
      gdrive_folder_url: `https://drive.google.com/drive/folders/${contactFolder.id}`,
      updated_at: new Date().toISOString(),
    })
    .eq('id', contactId)

  return { folderId: contactFolder.id, created: matches.length === 0, subfolders }
}

// ─── Phase 2: Company folder (post-company) ────────────────────────────────

export async function ensureCompanyFolder(
  accountId: string,
  companyName: string,
  stateOfFormation: string,
  ownerName?: string,
): Promise<{ folderId: string; created: boolean; subfolders: Record<string, string> }> {
  // Check if account already has drive_folder_id
  const { data: account } = await supabaseAdmin
    .from('accounts')
    .select('drive_folder_id')
    .eq('id', accountId)
    .single()

  if (account?.drive_folder_id) {
    const subfolders = await ensureSubfoldersOn(account.drive_folder_id)
    return { folderId: account.drive_folder_id, created: false, subfolders }
  }

  // Determine parent folder by state
  const { createFolder, listFiles } = await getDriveHelpers()
  let parentId = STATE_FOLDER_MAP[stateOfFormation] || null

  if (!parentId) {
    // Create new state folder under Companies/
    const stateFolder = await createFolder(COMPANIES_ROOT, stateOfFormation) as { id: string }
    parentId = stateFolder.id
  }

  // Folder name: "{CompanyName} - {OwnerName}" or just "{CompanyName}"
  const folderName = ownerName ? `${companyName} - ${ownerName}` : companyName

  // Check Drive for existing folder with the same name (dedup)
  const existingItems = await listFiles(parentId)
  const matches = existingItems.filter(
    f => f.name === folderName && f.mimeType === 'application/vnd.google-apps.folder',
  )

  let companyFolder: { id: string }
  if (matches.length === 1) {
    // Exact match — link to existing folder instead of creating duplicate
    companyFolder = { id: matches[0].id }
    console.warn(`[drive-folder-utils] Found existing folder "${folderName}" (${matches[0].id}) — linking instead of creating`)
  } else if (matches.length > 1) {
    // Multiple matches — cannot auto-link, require manual selection
    const ids = matches.map(m => m.id).join(', ')
    throw new Error(
      `Multiple Drive folders named "${folderName}" found (${ids}). ` +
      `Manual admin selection required — use "Link Existing Drive Folder" in the CRM.`
    )
  } else {
    // No match — create new folder
    companyFolder = await createFolder(parentId, folderName) as { id: string }
  }

  // Ensure standard subfolders exist (safe for both new and linked folders)
  const subfolders = await ensureSubfoldersOn(companyFolder.id)

  // Save to account
  // eslint-disable-next-line no-restricted-syntax -- Drive-folder-link bookkeeping, not client-facing CRM data; central path
  await supabaseAdmin
    .from('accounts')
    .update({
      drive_folder_id: companyFolder.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', accountId)

  return { folderId: companyFolder.id, created: true, subfolders }
}

// ─── Migration: Contact folder → Company folder ────────────────────────────

export async function migrateContactToCompany(
  contactFolderId: string,
  companyFolderId: string,
  contactId?: string,
): Promise<{ moved: number; errors: string[] }> {
  const { listFiles, moveFile } = await getDriveHelpers()
  const result = { moved: 0, errors: [] as string[] }

  // List contact subfolders
  const contactSubs = await listFiles(contactFolderId)
  const companySubs = await listFiles(companyFolderId)

  const companySubMap: Record<string, string> = {}
  for (const f of companySubs) {
    if (f.mimeType === 'application/vnd.google-apps.folder') {
      companySubMap[f.name] = f.id
    }
  }

  // For each contact subfolder, move its files to the matching company subfolder
  for (const contactSub of contactSubs) {
    if (contactSub.mimeType !== 'application/vnd.google-apps.folder') continue

    const targetId = companySubMap[contactSub.name]
    if (!targetId) {
      result.errors.push(`No matching company subfolder for "${contactSub.name}"`)
      continue
    }

    // List files in this contact subfolder
    const files = await listFiles(contactSub.id)
    for (const file of files) {
      if (file.mimeType === 'application/vnd.google-apps.folder') continue // skip nested folders
      try {
        await moveFile(file.id, targetId)
        result.moved++
      } catch (err) {
        result.errors.push(`Failed to move ${file.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // After migration, update contact's folder link to company's "2. Contacts" subfolder
  if (contactId) {
    const contactsSubfolderId = companySubMap['2. Contacts']
    if (contactsSubfolderId) {
      // eslint-disable-next-line no-restricted-syntax -- Drive-folder-link bookkeeping, not client-facing CRM data; central path
      await supabaseAdmin
        .from('contacts')
        .update({
          drive_folder_id: contactsSubfolderId,
          gdrive_folder_url: `https://drive.google.com/drive/folders/${contactsSubfolderId}`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', contactId)
    } else {
      console.warn(`[drive-folder-utils] migrateContactToCompany: No "2. Contacts" subfolder in company folder ${companyFolderId} — contact folder link not updated`)
    }
  }

  return result
}
