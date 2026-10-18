/**
 * Shared Google Drive folder utilities for the companies deliberately LEFT on Drive.
 *
 * Stop Drive (dev job 264bb882, S1d): ensureContactFolder() / ensureCompanyFolder() no longer CREATE folders. They return the
 * folder a legacy company/person already has (see lib/crm-store/legacy-drive.ts) and refuse everyone else with a staff alarm.
 *
 * Used by:
 * - formation-setup.ts (Phase 1)
 * - onboarding-setup.ts (Phase 2 directly)
 * - formation-materialize.ts::materializeFormationCompany (Phase 2 migration,
 *   triggered by the Formation Workspace's Articles-upload flow)
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

const STANDARD_SUBFOLDERS = [
  '1. Company',
  '2. Contacts',
  '3. Tax',
  '4. Banking',
  '5. Correspondence',
]

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

// ─── Phase 1: Contact folder (pre-company) ─────────────────────────────────

export async function ensureContactFolder(
  contactId: string,
  contactName: string,
): Promise<{ folderId: string; created: boolean; subfolders: Record<string, string> }> {
  // A person whose files live in the new CRM storage must not get a Drive folder (cutover, dev job ad09ea91) — one
  // central check so every caller (contact page, onboarding rebuild, formation job, uploads) is covered.
  {
    const { assertPersonFilesStillOnDrive } = await import('@/lib/crm-store/person-drive-guard')
    await assertPersonFilesStillOnDrive(contactId)
  }
  // Stop Drive (dev job 264bb882, S1d): this function NEVER creates a Drive folder any more. It hands back the folder that
  // already exists, and only for a person of a company that was deliberately left on Drive (folder, no storage, not closed).
  const { legacyDriveForAccount, legacyDriveForContact, raiseDriveWriteRefused, DriveWriteRefusedError } = await import('@/lib/crm-store/legacy-drive')
  const refuse = async (reason: Parameters<typeof raiseDriveWriteRefused>[0]['reason']): Promise<never> => {
    await raiseDriveWriteRefused({ flow: 'ensureContactFolder', contactId, reason, detail: contactName })
    throw new DriveWriteRefusedError(reason)
  }

  // A contact who already has a materialized company may have had
  // drive_folder_id repointed at the COMPANY's own "2. Contacts" leaf by
  // migrateContactToCompany() — a leaf folder, not a root with its own
  // subfolder tree. Resolve through the company's real folder in that case
  // (service_deliveries is the durable link: formation-materialize.ts writes account_id onto the contact's SD row).
  const { data: linkedSd } = await supabaseAdmin
    .from('service_deliveries')
    .select('account_id')
    .eq('contact_id', contactId)
    .not('account_id', 'is', null)
    .limit(1)
    .maybeSingle()

  if (linkedSd?.account_id) {
    const v = await legacyDriveForAccount(linkedSd.account_id)
    if (!v.allowed) return refuse(v.reason)
    const subfolders = await ensureSubfoldersOn(v.folderId)
    return { folderId: v.folderId, created: false, subfolders }
  }

  const v = await legacyDriveForContact(contactId)
  if (!v.allowed) return refuse(v.reason)
  // Self-heal any standard subfolder that is missing (the folder may predate the standard structure).
  const subfolders = await ensureSubfoldersOn(v.folderId)
  return { folderId: v.folderId, created: false, subfolders }
}

// ─── Phase 2: Company folder (post-company) ────────────────────────────────

export async function ensureCompanyFolder(
  accountId: string,
  companyName: string,
  stateOfFormation: string,
  ownerName?: string,
): Promise<{ folderId: string; created: boolean; subfolders: Record<string, string> }> {
  // A company whose files live in the new store never gets a Drive folder — and never has Drive subfolders
  // made in an existing one — whichever flow asks (tax intake, onboarding, RA switch, place-client …).
  // Checked BEFORE the existing-folder shortcut: a switched company keeps its old folder id (Drive stays
  // visible), so the shortcut would otherwise hand it back and the caller would write into Drive.
  const { assertNotStoreOwnedAccount } = await import('@/lib/crm-store/browse')
  await assertNotStoreOwnedAccount(accountId)

  // Stop Drive (dev job 264bb882, S1d): this function NEVER creates a Drive folder any more. It hands back the folder the
  // company already has — and only a company deliberately left on Drive (folder, no storage, not Closed / Cancelled).
  const { legacyDriveForAccount, raiseDriveWriteRefused, DriveWriteRefusedError } = await import('@/lib/crm-store/legacy-drive')
  const v = await legacyDriveForAccount(accountId)
  if (!v.allowed) {
    await raiseDriveWriteRefused({ flow: 'ensureCompanyFolder', accountId, reason: v.reason, detail: [companyName, stateOfFormation, ownerName].filter(Boolean).join(' / ') })
    throw new DriveWriteRefusedError(v.reason)
  }
  const subfolders = await ensureSubfoldersOn(v.folderId)
  return { folderId: v.folderId, created: false, subfolders }
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
