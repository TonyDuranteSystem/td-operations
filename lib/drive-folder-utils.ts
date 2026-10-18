/**
 * Shared Google Drive folder utilities for the companies deliberately LEFT on Drive.
 *
 * Stop Drive (dev job 264bb882, S1d): ensureContactFolder() / ensureCompanyFolder() never create a Drive folder — nor anything
 * inside one. They return the folder a legacy company/person already has (see lib/crm-store/legacy-drive.ts). A company or person
 * with no place for files gets their own CRM storage opened and the caller's storage branch takes over; a closed company is refused
 * with a staff alarm.
 *
 * Used by:
 * - formation-setup.ts (Phase 1)
 * - onboarding-setup.ts (Phase 2 directly)
 * - formation-materialize.ts::materializeFormationCompany (Phase 2 migration,
 *   triggered by the Formation Workspace's Articles-upload flow)
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

// ─── Types ─────────────────────────────────────────────────────────────────
interface DriveItem { id: string; name: string; mimeType: string }

// ─── Helper: lazy import google-drive ──────────────────────────────────────
async function getDriveHelpers() {
  const { listFolderAnyDrive, moveFile } = await import('@/lib/google-drive')
  // Wrap listFolderAnyDrive to return files array (it returns { files: [...] })
  const listFiles = async (folderId: string): Promise<DriveItem[]> => {
    const res = await listFolderAnyDrive(folderId)
    return (res as { files?: DriveItem[] }).files ?? []
  }
  return { listFiles, moveFile }
}

// ─── Helper: the standard subfolders a folder already has (READ ONLY) ──────
// Callers depend on specific subfolder names (e.g. "2. Contacts"). A missing one is NOT created any more (no Drive writes).
async function existingSubfolders(folderId: string): Promise<Record<string, string>> {
  const { listFiles } = await getDriveHelpers()
  const out: Record<string, string> = {}
  for (const f of await listFiles(folderId)) {
    if (f.mimeType === 'application/vnd.google-apps.folder') out[f.name] = f.id
  }
  return out
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
  // Stop Drive (dev job 264bb882, S1d): this function NEVER creates a Drive folder (or anything inside one). It hands back the
  // folder that already exists, and only for a person of a company deliberately left on Drive (folder, no storage, not closed).
  // Anyone else gets their OWN storage opened and the caller's storage branch takes over (PersonFilesInStorageError) — except a
  // person of a closed company or of a company being moved, who is refused with a staff alarm.
  const { legacyDriveForContact, raiseDriveWriteRefused, LegacyDriveRefusedError } = await import('@/lib/crm-store/legacy-drive')
  const v = await legacyDriveForContact(contactId)
  if (!v.allowed) {
    if (v.reason === 'archived' || v.reason === 'moving') {
      await raiseDriveWriteRefused({ flow: 'ensureContactFolder', contactId, reason: v.reason, detail: contactName })
      throw new LegacyDriveRefusedError(v.reason)
    }
    const { ensurePersonOwner } = await import('@/lib/crm-store/formation-pilot')
    await ensurePersonOwner(contactId, contactName || 'Client')
    const { PersonFilesInStorageError } = await import('@/lib/crm-store/person-drive-guard')
    throw new PersonFilesInStorageError()
  }
  return { folderId: v.folderId as string, created: false, subfolders: await existingSubfolders(v.folderId as string) }
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
  const { assertNotStoreOwnedAccount } = await import('@/lib/crm-store/browse')
  await assertNotStoreOwnedAccount(accountId)

  // Stop Drive (dev job 264bb882, S1d): this function NEVER creates a Drive folder (or anything inside one). It hands back the
  // folder the company already has — only a company deliberately left on Drive (folder, no storage, not Closed / Cancelled).
  // A company with NO place for files (created by onboarding, place-client or a standalone tax intake) gets its own storage
  // opened here and the caller's storage branch takes over (StoreOwnedAccountError); a closed one is refused with a staff alarm.
  const { legacyDriveForAccount, raiseDriveWriteRefused, LegacyDriveRefusedError } = await import('@/lib/crm-store/legacy-drive')
  const v = await legacyDriveForAccount(accountId)
  if (!v.allowed) {
    if (v.reason === 'no_folder') {
      const { ensureCompanyStorage } = await import('@/lib/crm-store/company-storage')
      await ensureCompanyStorage(accountId, companyName)
      const { StoreOwnedAccountError } = await import('@/lib/crm-store/account-uploads')
      throw new StoreOwnedAccountError("This company's files now live in the new CRM storage (opened just now) — it does not get a Google Drive folder.")
    }
    await raiseDriveWriteRefused({ flow: 'ensureCompanyFolder', accountId, reason: v.reason, detail: [companyName, stateOfFormation, ownerName].filter(Boolean).join(' / ') })
    throw new LegacyDriveRefusedError(v.reason)
  }
  return { folderId: v.folderId as string, created: false, subfolders: await existingSubfolders(v.folderId as string) }
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
