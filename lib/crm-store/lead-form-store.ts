/**
 * CRM Store — where a form's package goes when the person or company has no Drive folder (Stop-Drive S1a, dev job 264bb882).
 *
 * The formation / onboarding / closure completion routes used to build a "Leads/<name>" folder in Google Drive and file the
 * summary PDF + the client's uploads there. They now file into the new storage, exactly like a brand-new client: the person's
 * own storage (opened on first use, same call the new-client flow uses) or, for a company that is already in the storage,
 * the company's. The answer is a destination marker that `saveFormToDrive` understands ("person-storage:<id>" /
 * "account-storage:<id>"); nothing here touches Google Drive.
 *
 * Safety rules (fix round 2026-10-18):
 *  - A person's storage is opened ONLY for someone who does not live on Drive: opening one for a member of a still-Drive company
 *    (or for someone who has a Drive folder but no storage) would lock their Drive folder and break the company's later Drive saves.
 *  - A person who only has a hidden "study copy" storage is a Drive person: nothing is ever filed into a hidden, unbacked copy.
 *  - A lead is matched to a contact by EXACT email only (case-insensitive, no wildcards). Zero or several matches = nobody is guessed.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export type FormDestination =
  | { marker: string; reason?: undefined }
  | { marker: null; reason: "no_contact" | "person_on_drive" | "study_only_owner" }

export interface FormStorageInput {
  accountId?: string | null
  contactId?: string | null
  /** fallback only — the root folder is named from the CRM contact's own name when it can be read */
  personName?: string | null
}

export interface FormStorageDeps {
  liveOwnerOfAccount: (accountId: string) => Promise<string | null>
  liveOwnerOfContact: (contactId: string) => Promise<string | null>
  hasStudyOnlyOwner: (contactId: string) => Promise<boolean>
  /** the CRM contact: name, whether it has a Drive folder, and the companies it is linked to */
  contactFacts: (contactId: string) => Promise<{ fullName: string | null; hasDriveFolder: boolean; accountIds: string[] }>
  companyState: (accountId: string) => Promise<"store" | "drive" | "moving">
  ensurePersonOwner: (contactId: string, rootName: string) => Promise<string>
}

async function defaultDeps(): Promise<FormStorageDeps> {
  const guard = await import("./switched-drive-guard")
  const pilot = await import("./formation-pilot")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types
  const d = supabaseAdmin as any
  return {
    liveOwnerOfAccount: guard.liveOwnerOfAccount,
    liveOwnerOfContact: guard.liveOwnerOfContact,
    hasStudyOnlyOwner: async (id) => {
      const { data, error } = await d.from("store_owners").select("id").eq("contact_id", id).eq("kind", "person").eq("study_only", true).limit(1)
      if (error) throw new Error("Could not check where this person's files live — please try again.")
      return (data ?? []).length > 0
    },
    contactFacts: async (id) => {
      const { data: c, error } = await supabaseAdmin.from("contacts").select("full_name, drive_folder_id, gdrive_folder_url").eq("id", id).maybeSingle()
      if (error) throw new Error("Could not read the contact — please try again.")
      const { data: links, error: lErr } = await supabaseAdmin.from("account_contacts").select("account_id").eq("contact_id", id)
      if (lErr) throw new Error("Could not read the contact's companies — please try again.")
      return {
        fullName: (c?.full_name as string | null | undefined) ?? null,
        hasDriveFolder: !!(c?.drive_folder_id || c?.gdrive_folder_url),
        accountIds: (links ?? []).map((l) => l.account_id as string),
      }
    },
    companyState: guard.companyDocState as FormStorageDeps["companyState"],
    ensurePersonOwner: pilot.ensurePersonOwner,
  }
}

/**
 * The storage destination for a form package, opening the person's storage if they have none yet and it is safe to.
 * A company that already has storage wins over the person (its closure/onboarding papers belong with the company).
 * `marker: null` = nothing can be filed here (the caller says so loudly where it matters); it never means "use Drive".
 * Throws on a read/open failure so a retry can run.
 */
export async function storageDestinationForForm(input: FormStorageInput, deps?: FormStorageDeps): Promise<FormDestination> {
  const d = deps ?? (await defaultDeps())
  if (input.accountId && (await d.liveOwnerOfAccount(input.accountId))) return { marker: `account-storage:${input.accountId}` }
  const contactId = input.contactId
  if (!contactId) return { marker: null, reason: "no_contact" }

  if (await d.liveOwnerOfContact(contactId)) return { marker: `person-storage:${contactId}` }

  // No live storage yet. A hidden study copy means this person still lives on Drive: never file into it.
  if (await d.hasStudyOnlyOwner(contactId)) return { marker: null, reason: "study_only_owner" }

  const facts = await d.contactFacts(contactId)
  if (facts.hasDriveFolder) {
    // They have a Drive folder and no storage. Safe to open one only when every company they belong to is already in the storage
    // (their folder is then already under the lock). Any company still on Drive, still moving, or none at all: they are a Drive person.
    let allInStorage = facts.accountIds.length > 0
    for (const a of facts.accountIds) {
      if ((await d.companyState(a)) !== "store") { allInStorage = false; break }
    }
    if (!allInStorage) return { marker: null, reason: "person_on_drive" }
  }

  const name = facts.fullName?.trim() || input.personName?.trim() || "Client"
  const ownerId = await d.ensurePersonOwner(contactId, name)
  if (!ownerId) throw new Error("This person's storage could not be opened — nothing was filed.")
  return { marker: `person-storage:${contactId}` }
}

export type ContactMatch = { status: "none" } | { status: "one"; id: string } | { status: "many"; ids: string[] }

/** Escape the characters a LIKE pattern treats as wildcards, so ilike() becomes a plain case-insensitive equality. */
export function escapeLikeExact(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * The CRM contact whose email is EXACTLY this one (case-insensitive, surrounding spaces ignored, no wildcards).
 * `many` and `none` are separate answers — the caller must not pick one of several.
 */
export async function findContactByExactEmail(email: string | null | undefined): Promise<ContactMatch> {
  const wanted = (email ?? "").trim().toLowerCase()
  if (!wanted) return { status: "none" }
  const { data, error } = await supabaseAdmin.from("contacts").select("id, email").ilike("email", escapeLikeExact(wanted)).limit(10)
  if (error) throw new Error(`Could not look up the contact: ${error.message}`)
  const ids = (data ?? []).filter((r) => (r.email ?? "").trim().toLowerCase() === wanted).map((r) => r.id as string)
  if (ids.length === 0) return { status: "none" }
  if (ids.length === 1) return { status: "one", id: ids[0] }
  return { status: "many", ids }
}
