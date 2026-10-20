/**
 * Company / person "folder" gates (the file name is historical).
 *
 * Stop Drive S2 (dev job 264bb882): NOTHING is ever written to Google Drive any more, so these functions can no longer hand back a
 * Drive folder to write into — they never RETURN. They decide the true state and throw the error the caller's storage branch
 * already understands:
 *   - a company / person with no storage that is OPEN gets its own CRM storage opened here, and the call throws
 *     StoreOwnedAccountError / PersonFilesInStorageError (the caller then files into that storage);
 *   - a company being moved right now, a closed company, and a company frozen on its old Drive folder (REBIS, YBR, Degasper,
 *     Fresh Legal) are refused with LegacyDriveRefusedError plus a staff alarm (once an hour per cause).
 * The Drive-folder creation, subfolder creation and contact→company folder migration that used to live here are gone.
 *
 * Used by:
 * - formation-setup.ts (Phase 1)
 * - onboarding-setup.ts (Phase 2 directly)
 * - formation-materialize.ts::materializeFormationCompany
 * - place-client, tax-return-intake, contact upload routes
 */

// ─── Phase 1: Contact folder (pre-company) ─────────────────────────────────

/** Never returns (Stop Drive S2): opens the person's own storage and throws PersonFilesInStorageError, or refuses (moving). */
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
  // This function NEVER creates a Drive folder and NEVER hands one back. A person gets their OWN storage opened and the caller's
  // storage branch takes over (PersonFilesInStorageError) — except a person of a company being moved right now, who is refused
  // with a staff alarm (a closed or frozen company does not stop a person from getting their own storage).
  const { legacyDriveForContact, raiseDriveWriteRefused, LegacyDriveRefusedError } = await import('@/lib/crm-store/legacy-drive')
  const v = await legacyDriveForContact(contactId)
  if (v.reason === 'moving') {
    await raiseDriveWriteRefused({ flow: 'ensureContactFolder', contactId, reason: v.reason, detail: contactName })
    throw new LegacyDriveRefusedError(v.reason)
  }
  const { ensurePersonOwner } = await import('@/lib/crm-store/formation-pilot')
  await ensurePersonOwner(contactId, contactName || 'Client')
  const { PersonFilesInStorageError } = await import('@/lib/crm-store/person-drive-guard')
  throw new PersonFilesInStorageError()
}

// ─── Phase 2: Company folder (post-company) ────────────────────────────────

/** Never returns (Stop Drive S2): opens an open company's storage and throws StoreOwnedAccountError, or refuses with a staff alarm. */
export async function ensureCompanyFolder(
  accountId: string,
  companyName: string,
  stateOfFormation: string,
  ownerName?: string,
): Promise<{ folderId: string; created: boolean; subfolders: Record<string, string> }> {
  // A company whose files live in the new store never gets a Drive folder — whichever flow asks (tax intake, onboarding, RA switch,
  // place-client …).
  const { assertNotStoreOwnedAccount } = await import('@/lib/crm-store/browse')
  await assertNotStoreOwnedAccount(accountId)

  // This function NEVER creates a Drive folder and NEVER hands one back. A company with NO place for files (created by
  // onboarding, place-client or a standalone tax intake) gets its own storage opened here and the caller's storage branch takes over
  // (StoreOwnedAccountError); a closed one, one being moved, and one frozen on its old Drive folder are refused with a staff alarm.
  const { legacyDriveForAccount, raiseDriveWriteRefused, LegacyDriveRefusedError } = await import('@/lib/crm-store/legacy-drive')
  const v = await legacyDriveForAccount(accountId)
  if (v.reason === 'no_folder') {
    const { ensureCompanyStorage } = await import('@/lib/crm-store/company-storage')
    const { StoreOwnedAccountError } = await import('@/lib/crm-store/account-uploads')
    try {
      await ensureCompanyStorage(accountId, companyName)
    } catch (e) {
      // the buyer's formation already owns a storage: no second one is opened — the company gets THAT one when it is attached
      if (e instanceof Error && e.name === 'FormationOwnerPendingError') throw new StoreOwnedAccountError("This company's files go to its formation's storage (attached to the company) — it does not get a Google Drive folder.")
      throw e
    }
    throw new StoreOwnedAccountError("This company's files now live in the new CRM storage (opened just now) — it does not get a Google Drive folder.")
  }
  await raiseDriveWriteRefused({ flow: 'ensureCompanyFolder', accountId, reason: v.reason, detail: [companyName, stateOfFormation, ownerName].filter(Boolean).join(' / ') })
  throw new LegacyDriveRefusedError(v.reason)
}
