/**
 * Drive cutover Phase A2 (dev job ad09ea91, master plan Part 33): a PERSON whose files live in the new storage must not get a
 * new Drive folder created or an existing one linked — the contact page's "Create Drive folder" / "Link folder" would re-open the
 * Drive path for them (the account page already refuses the same thing: assertNotStoreOwnedAccount).
 *
 * "Their files live in the storage" = the person has their own LIVE storage, or ANY company they belong to is switched
 * or mid-move (the person's storage is opened for them on first use). Strict: a read error throws (never read as "no").
 */

export interface PersonDriveGuardDeps {
  liveOwner(contactId: string): Promise<string | null>
  linkedAccountIds(contactId: string): Promise<string[]>
  companyState(accountId: string): Promise<"drive" | "moving" | "store">
}

const defaultDeps: PersonDriveGuardDeps = {
  async liveOwner(contactId) {
    const { liveOwnerOfContact } = await import("./switched-drive-guard")
    return liveOwnerOfContact(contactId)
  },
  async linkedAccountIds(contactId) {
    const { supabaseAdmin } = await import("@/lib/supabase-admin")
    const { data, error } = await supabaseAdmin.from("account_contacts").select("account_id").eq("contact_id", contactId)
    if (error) throw new Error(`Could not check which companies this person belongs to (${error.message}) — please try again.`)
    return (data ?? []).map((r: { account_id: string }) => r.account_id)
  },
  async companyState(accountId) {
    const { companyDocState } = await import("./switched-drive-guard")
    return companyDocState(accountId)
  },
}

export class PersonFilesInStorageError extends Error {
  constructor() {
    super("This person's files live in the new storage — a Drive folder can't be created or linked for them. Work in Storage.")
    this.name = "PersonFilesInStorageError"
  }
}

export async function personHasFilesInStorage(contactId: string, deps: PersonDriveGuardDeps = defaultDeps): Promise<boolean> {
  if (await deps.liveOwner(contactId)) return true
  for (const accountId of await deps.linkedAccountIds(contactId)) {
    if ((await deps.companyState(accountId)) !== "drive") return true
  }
  return false
}

/** Throws PersonFilesInStorageError when the person's files are in the new storage (or a read fails). */
export async function assertPersonFilesStillOnDrive(contactId: string, deps?: PersonDriveGuardDeps): Promise<void> {
  if (await personHasFilesInStorage(contactId, deps)) throw new PersonFilesInStorageError()
}
