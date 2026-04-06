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
  // Check if contact already has a Drive folder
  const { data: contact } = await supabaseAdmin
    .from('contacts')
    .select('gdrive_folder_url')
    .eq('id', contactId)
    .single()

  // If contact has a Drive folder URL, extract the folder ID
  if (contact?.gdrive_folder_url) {
    const idMatch = (contact.gdrive_folder_url as string).match(/folders\/([a-zA-Z0-9_-]+)/)
    if (idMatch) {
      const existingId = idMatch[1]
      const { listFiles } = await getDriveHelpers()
      const subs = await listFiles(existingId)
      const subfolders: Record<string, string> = {}
      for (const f of subs) {
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          subfolders[f.name] = f.id
        }
      }
      return { folderId: existingId, created: false, subfolders }
    }
  }

  // Create folder: Contacts/{ContactName}/
  const rootId = await ensureContactsRoot()
  const { createFolder } = await getDriveHelpers()

  const folder = await createFolder(rootId, contactName) as { id: string }

  // Create standard subfolders
  const subfolders: Record<string, string> = {}
  for (const subName of STANDARD_SUBFOLDERS) {
    try {
      const sub = await createFolder(folder.id, subName) as { id: string }
      subfolders[subName] = sub.id
    } catch (err) {
      console.warn(`[drive-folder-utils] Failed to create subfolder ${subName}:`, err)
    }
  }

  // Save to contact record
  await supabaseAdmin
    .from('contacts')
    .update({
      gdrive_folder_url: `https://drive.google.com/drive/folders/${folder.id}`,
      updated_at: new Date().toISOString(),
    })
    .eq('id', contactId)

  return { folderId: folder.id, created: true, subfolders }
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
    const { listFiles } = await getDriveHelpers()
    const subs = await listFiles(account.drive_folder_id)
    const subfolders: Record<string, string> = {}
    for (const f of subs) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        subfolders[f.name] = f.id
      }
    }
    return { folderId: account.drive_folder_id, created: false, subfolders }
  }

  // Determine parent folder by state
  const { createFolder } = await getDriveHelpers()
  let parentId = STATE_FOLDER_MAP[stateOfFormation] || null

  if (!parentId) {
    // Create new state folder under Companies/
    const stateFolder = await createFolder(COMPANIES_ROOT, stateOfFormation) as { id: string }
    parentId = stateFolder.id
  }

  // Folder name: "{CompanyName} - {OwnerName}" or just "{CompanyName}"
  const folderName = ownerName ? `${companyName} - ${ownerName}` : companyName
  const companyFolder = await createFolder(parentId, folderName) as { id: string }

  // Create standard subfolders
  const subfolders: Record<string, string> = {}
  for (const subName of STANDARD_SUBFOLDERS) {
    try {
      const sub = await createFolder(companyFolder.id, subName) as { id: string }
      subfolders[subName] = sub.id
    } catch (err) {
      console.warn(`[drive-folder-utils] Failed to create subfolder ${subName}:`, err)
    }
  }

  // Save to account
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

  return result
}
