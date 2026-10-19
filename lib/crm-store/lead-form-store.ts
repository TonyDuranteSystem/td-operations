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
import { normalizePersonName } from "@/lib/members/member-identity"

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
  const pattern = `%${escapeLikeExact(wanted)}%`
  const found = new Map<string, string | null>()
  // Same identity rules as the rest of the CRM (lib/operations/find-contact-by-email.ts): a MERGED-AWAY contact (merged_into set) is never a
  // candidate, and an old address folded into a survivor (alt_emails) or a second address (email_2) counts as that person's email.
  // Pages in a fixed order until the list is exhausted (bounded), equality decided here in code, so a short address contained in many longer
  // ones cannot push the real match out of view and an address stored with stray spaces is still found.
  for (const column of ["email", "email_2"] as const) {
    for (let page = 0; page < 20; page++) {
      const { data, error } = await supabaseAdmin.from("contacts").select(`id, ${column}, full_name`).is("merged_into", null).ilike(column, pattern).order("id").range(page * 200, page * 200 + 199)
      if (error) throw new Error(`Could not look up the contact: ${error.message}`)
      for (const r of (data ?? []) as unknown as Array<Record<string, string | null>>) if ((r[column] ?? "").trim().toLowerCase() === wanted) found.set(r.id as string, r.full_name ?? null)
      if (!data || data.length < 200) break
    }
  }
  const { data: alias, error: aErr } = await supabaseAdmin.from("contacts").select("id, full_name").is("merged_into", null).contains("alt_emails", [wanted]).order("id").limit(50)
  if (aErr) throw new Error(`Could not look up the contact: ${aErr.message}`)
  for (const r of alias ?? []) found.set(r.id as string, (r.full_name as string | null) ?? null)
  const ids = Array.from(found.keys())
  if (ids.length === 0) return { status: "none" }
  if (ids.length === 1) return { status: "one", id: ids[0], fullName: found.get(ids[0]) ?? null }
  return { status: "many", ids }
}

// letters that do not decompose into base letter + accent
const SPECIAL: Record<string, string> = { "ß": "ss", "ø": "o", "đ": "d", "ð": "d", "ł": "l", "æ": "ae", "œ": "oe", "þ": "th", "ı": "i" }
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"])
const NON_WORD = new RegExp("[^\\p{L}\\p{N}\\s]+", "gu")
const COMBINING = new RegExp("[\\u0300-\\u036f]", "g")

/** Name -> comparable word list. `german` spells ä/ö/ü as ae/oe/ue (Müller = Mueller). Hyphens/apostrophes join (Anne-Marie = Annemarie). */
function nameTokens(raw: string, german: boolean): string[] {
  let v = raw.toLowerCase()
  if (german) v = v.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
  v = v.replace(/[ßøđðłæœþı]/g, (c) => SPECIAL[c] ?? c)
  v = v.normalize("NFD").replace(COMBINING, "").replace(/[-'’`.]/g, "").replace(NON_WORD, " ")
  return v.split(/\s+/).filter((t) => t && !SUFFIXES.has(t))
}

/** Same words, in any order — NOTHING else (no subset, no "shared last name", no left-out middle name). */
function tokenListsMatch(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false
  return a.length === b.length && a.slice().sort().join(" ") === b.slice().sort().join(" ")
}

/**
 * Do two person names mean the same person? ONLY when the full names are the same words: first AND last (and any other word), in any
 * order, ignoring case, accents, punctuation, hyphens and German spellings (Müller = Mueller). A shared last name alone is never
 * enough; a left-out middle name, a single word against a full name, or a generational suffix on one side only (Jr, III) is NOT a
 * match. Non-Latin names (李小龙) are compared as written, word for word — never reduced to nothing. A name with no comparable
 * letters on either side matches nothing. The caller treats every "no" as ambiguous: nothing filed, one alarm.
 */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? "").trim(), y = (b ?? "").trim()
  if (!x || !y) return false
  // A name with no comparable letters or digits ("!!!") matches nothing — not even itself.
  if (nameTokens(x, false).length === 0 || nameTokens(y, false).length === 0) return false
  // Generational suffixes (Sr / Jr / II / III / IV) separate DIFFERENT people who may share one address (father and son): a suffix on one side
  // only, or two different suffixes, is never a match.
  if (suffixesOf(x) !== suffixesOf(y)) return false
  // 1. The CRM's own member rule first (lib/members/member-identity.ts: NFC, trimmed, lower-cased, spaces collapsed) — the strict base.
  if (normalizePersonName(x) === normalizePersonName(y)) return true
  // 2. Lenient extras (lead forms only: both sides already share the SAME exact email, and a doubt only ever ends in "ambiguous").
  return tokenListsMatch(nameTokens(x, false), nameTokens(y, false)) || tokenListsMatch(nameTokens(x, true), nameTokens(y, true))
}

/** The generational suffixes present in a name, as one comparable string ("" = none). */
function suffixesOf(raw: string): string {
  return raw.toLowerCase().replace(/[.,]/g, " ").split(/\s+/).filter((t) => SUFFIXES.has(t)).sort().join(",")
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

/**
 * Record the decided contact on a form submission (idempotent: only fills an empty contact_id, never overwrites). Callers pass a contact
 * only when it is CERTAIN (exact email + matching name, or created from this very lead). Later tools and the retry recipes then agree on
 * who the person is. Returns true when it wrote, false when the row already had a contact (or nothing matched).
 */
export async function recordSubmissionContact(table: "formation_submissions" | "onboarding_submissions" | "itin_submissions", submissionId: string, contactId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.from(table).update({ contact_id: contactId }).eq("id", submissionId).is("contact_id", null).select("id")
  if (error) throw new Error(`Could not record the contact on the submission: ${error.message}`)
  return (data ?? []).length > 0
}

/**
 * The ONE rule every staff/MCP form-creation tool uses to attach a CRM contact to a lead: the contact whose email is exactly the lead's
 * AND whose full name is the same (see namesMatch). Anything else — no contact, several, a different name on a shared email, a failed
 * lookup — returns null (the form is made without a contact; nobody else's data prefills it) and raises the ONE existing alarm when it
 * was a doubt rather than a plain "no contact".
 */
export async function contactIdForLead(p: { email: string | null | undefined; fullName: string | null | undefined; route: string; leadId?: string | null }): Promise<string | null> {
  if (!(p.email ?? "").trim()) return null
  const found = await lookupLeadContact({ email: p.email, leadName: p.fullName, route: p.route, leadId: p.leadId ?? null })
  return found.state === "one" ? found.contactId : null
}
