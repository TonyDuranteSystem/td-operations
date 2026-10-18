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
 *  - Everything new goes to the storage (Antonio 2026-10-18: Drive is archive only): a returning client with a Drive folder and an old
 *    company still on Drive gets their storage opened too, so the package is never stranded. The only lock this adds is on their own
 *    contact folder; the lead-stage forms (incl. ITIN) never write to that folder any more, and a shared "2. Contacts" folder no longer
 *    makes a form fail because no form looks the folder up.
 *  - A person who only has a hidden "study copy" storage is held: nothing is ever filed into a hidden, unbacked copy (one alarm, retried).
 *  - A lead is matched to a contact by EXACT email only (case-insensitive, no wildcards). Zero or several matches = nobody is guessed.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export type FormDestination =
  | { marker: string; reason?: undefined }
  | { marker: null; reason: "no_contact" | "study_only_owner" }

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
  /** the CRM contact's own name (the person's root folder is named from it) */
  contactFacts: (contactId: string) => Promise<{ fullName: string | null }>
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
      const { data: c, error } = await supabaseAdmin.from("contacts").select("full_name").eq("id", id).maybeSingle()
      if (error) throw new Error("Could not read the contact — please try again.")
      return { fullName: (c?.full_name as string | null | undefined) ?? null }
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
  if (input.accountId && (await d.liveOwnerOfAccount(input.accountId))) {
    // a company in the middle of its move opens nothing and takes nothing: the caller retries (same rule as every company save)
    if ((await d.companyState(input.accountId)) === "moving") throw new Error("This company's files are being moved to the new storage right now — please try again in a few minutes.")
    return { marker: `account-storage:${input.accountId}` }
  }
  const contactId = input.contactId
  if (!contactId) return { marker: null, reason: "no_contact" }

  if (await d.liveOwnerOfContact(contactId)) return { marker: `person-storage:${contactId}` }

  // No live storage yet. A hidden study copy means this person still lives on Drive: never file into it.
  if (await d.hasStudyOnlyOwner(contactId)) return { marker: null, reason: "study_only_owner" }

  const facts = await d.contactFacts(contactId)
  const name = facts.fullName?.trim() || input.personName?.trim() || "Client"
  const ownerId = await d.ensurePersonOwner(contactId, name)
  if (!ownerId) throw new Error("This person's storage could not be opened — nothing was filed.")
  return { marker: `person-storage:${contactId}` }
}

export type ContactMatch = { status: "none" } | { status: "one"; id: string; fullName: string | null } | { status: "many"; ids: string[] }

/** Escape the characters a LIKE pattern treats as wildcards, so ilike() becomes a plain case-insensitive match. */
export function escapeLikeExact(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * The CRM contact whose email is EXACTLY this one (case-insensitive; spaces around a stored address are ignored; no wildcards).
 * The database is asked for rows CONTAINING the address (so a stored " a@x.it " is found too) and the equality is decided here.
 * `many` and `none` are separate answers — the caller must not pick one of several. Throws on a database error.
 */
export async function findContactByExactEmail(email: string | null | undefined): Promise<ContactMatch> {
  const wanted = (email ?? "").trim().toLowerCase()
  if (!wanted) return { status: "none" }
  const { data, error } = await supabaseAdmin.from("contacts").select("id, email, full_name").ilike("email", `%${escapeLikeExact(wanted)}%`).limit(200)
  if (error) throw new Error(`Could not look up the contact: ${error.message}`)
  const hits = (data ?? []).filter((r) => (r.email ?? "").trim().toLowerCase() === wanted)
  if (hits.length === 0) return { status: "none" }
  if (hits.length === 1) return { status: "one", id: hits[0].id as string, fullName: (hits[0].full_name as string | null) ?? null }
  return { status: "many", ids: hits.map((h) => h.id as string) }
}

const fold = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).sort().join(" ")

/**
 * Do two person names mean the same person? Case, accents, punctuation and the order of first/last name are ignored.
 * An empty name on either side cannot disprove anything, so it matches (the email already matched).
 */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = fold(a ?? ""), y = fold(b ?? "")
  if (!x || !y) return true
  return x === y
}

export type LeadContact =
  | { state: "one"; contactId: string }
  | { state: "none" }
  | { state: "ambiguous" | "error"; detail: string }

/**
 * The contact for a lead, with ONE staff alarm when it cannot be decided safely:
 *  - several contacts share the email                         → ambiguous
 *  - one contact matches but under a DIFFERENT NAME (a couple sharing one address: lead Mario, contact Maria) → ambiguous
 *  - the lookup itself failed                                   → error (the route carries on; nothing is filed or overwritten)
 * Ambiguous / error mean: do not file, do not update the contact, do not create one.
 */
export async function lookupLeadContact(p: { email: string | null | undefined; leadName: string | null | undefined; route: string; leadId?: string | null; token?: string | null; quiet?: boolean }): Promise<LeadContact> {
  const real = await import("./formation-pilot")
  // quiet = a retry/sweep re-resolving the same lead: the first attempt already alarmed, the sweep alerts at the limit
  const raisePilotAlarm: typeof real.raisePilotAlarm = p.quiet ? async () => {} : real.raisePilotAlarm
  try {
    const m = await findContactByExactEmail(p.email)
    if (m.status === "none") return { state: "none" }
    if (m.status === "many") {
      await raisePilotAlarm("lead_form_contact_ambiguous", { route: p.route, leadId: p.leadId ?? null, token: p.token ?? null, why: "several contacts share this email", contactIds: m.ids })
      return { state: "ambiguous", detail: `${m.ids.length} contacts share this email — none was used` }
    }
    if (!namesMatch(p.leadName, m.fullName)) {
      await raisePilotAlarm("lead_form_contact_ambiguous", { route: p.route, leadId: p.leadId ?? null, token: p.token ?? null, why: "the email matches a contact with a different name", contactIds: [m.id] })
      return { state: "ambiguous", detail: "the email belongs to a contact with a different name — it was not used" }
    }
    return { state: "one", contactId: m.id }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    await raisePilotAlarm("lead_form_contact_lookup_failed", { route: p.route, leadId: p.leadId ?? null, token: p.token ?? null, error: detail })
    return { state: "error", detail }
  }
}

/** The contact a stored submission belongs to: its own contact_id, else the lead's contact by exact email + name. null = undecided (no guess). */
export async function contactForSubmissionRow(row: { contact_id?: unknown; lead_id?: unknown; token?: unknown }, route: string): Promise<string | null> {
  if (typeof row.contact_id === "string" && row.contact_id) return row.contact_id
  if (typeof row.lead_id !== "string" || !row.lead_id) return null
  const { data: lead } = await supabaseAdmin.from("leads").select("full_name, email").eq("id", row.lead_id).maybeSingle()
  if (!lead) return null
  const found = await lookupLeadContact({ email: lead.email, leadName: lead.full_name, route, leadId: row.lead_id, token: typeof row.token === "string" ? row.token : null, quiet: true })
  return found.state === "one" ? found.contactId : null
}
