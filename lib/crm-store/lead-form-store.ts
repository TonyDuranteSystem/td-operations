/**
 * CRM Store — where a form's package goes when the person or company has no Drive folder (Stop-Drive S1a, dev job 264bb882).
 *
 * The formation / onboarding / closure completion routes used to build a "Leads/<name>" folder in Google Drive and file the
 * summary PDF + the client's uploads there. They now file into the new storage, exactly like a brand-new client: the person's
 * own storage (opened on first use, same call the new-client flow uses) or, for a company that is already in the storage,
 * the company's. The answer is a destination marker that `saveFormToDrive` understands ("person-storage:<id>" /
 * "account-storage:<id>"); nothing here touches Google Drive.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export interface FormStorageInput {
  accountId?: string | null
  contactId?: string | null
  /** the person's name — only used to name the root folder when their storage is opened */
  personName?: string | null
}

export interface FormStorageDeps {
  liveOwnerOfAccount: (accountId: string) => Promise<string | null>
  liveOwnerOfContact: (contactId: string) => Promise<string | null>
  ensurePersonOwner: (contactId: string, rootName: string) => Promise<string>
  contactName: (contactId: string) => Promise<string | null>
}

async function defaultDeps(): Promise<FormStorageDeps> {
  const guard = await import("./switched-drive-guard")
  const pilot = await import("./formation-pilot")
  return {
    liveOwnerOfAccount: guard.liveOwnerOfAccount,
    liveOwnerOfContact: guard.liveOwnerOfContact,
    ensurePersonOwner: pilot.ensurePersonOwner,
    contactName: async (id) => {
      const { data } = await supabaseAdmin.from("contacts").select("full_name").eq("id", id).maybeSingle()
      return (data?.full_name as string | null | undefined) ?? null
    },
  }
}

/**
 * The storage destination for a form package, opening the person's storage if they have none yet.
 * A company that already has storage wins over the person (its closure/onboarding papers belong with the company).
 * Returns null when there is neither a storage-backed company nor a contact record to open a storage for — the caller
 * then files nothing (the submission's own uploads stay where the client put them) and says so; it never falls back to Drive.
 * Throws on a read/open failure so a retry can run.
 */
export async function storageDestinationForForm(input: FormStorageInput, deps?: FormStorageDeps): Promise<string | null> {
  const d = deps ?? (await defaultDeps())
  if (input.accountId && (await d.liveOwnerOfAccount(input.accountId))) return `account-storage:${input.accountId}`
  if (input.contactId) {
    if (!(await d.liveOwnerOfContact(input.contactId))) {
      const name = (input.personName && input.personName.trim()) || (await d.contactName(input.contactId)) || "Client"
      await d.ensurePersonOwner(input.contactId, name)
    }
    return `person-storage:${input.contactId}`
  }
  return null
}
