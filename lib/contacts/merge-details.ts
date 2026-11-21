/**
 * Contact merge — the pure rules (dev job 938af003, slice 1). No database here.
 *
 * Mirrors what the database function `merge_contacts` does with personal details (migration
 * 20261117-2000): a detail that is EMPTY on the kept contact ('', spaces or NULL) is copied from the removed one;
 * when BOTH have a different value the person must choose, and for identity details (passport, ITIN, date of birth)
 * there is no default at all. Never copied: portal_tier, passport_on_file, email, notes, ids, language.
 * The database re-checks the identity rule, so a caller cannot skip the choice by calling the route directly.
 */
import { isUnresolvedPersonalDocument } from "@/lib/documents/visibility-guard"

/** Details copied when empty on the kept contact. Same list as the SQL function (keep both in step). */
export const PLAIN_DETAIL_FIELDS = [
  "phone", "phone_2", "phone_3", "phone_4", "email_2", "citizenship", "residency", "gender",
] as const

/** The address is ONE block, chosen with the key `address_line1` (a mixed address is never built). Same as the SQL function. */
export const ADDRESS_FIELDS = ["address_line1", "address_city", "address_state", "address_zip", "address_country"] as const
export const ADDRESS_KEY = "address_line1"

/** A passport expiry / ITIN issue date belongs to ITS number: it is not copied next to the other person's different number. */
export const DEPENDS_ON: Record<string, string> = { passport_expiry_date: "passport_number", itin_issue_date: "itin_number" }

export const PHONE_FIELDS = ["phone", "phone_2", "phone_3", "phone_4"] as const

/** Identity details: no default when the two differ, the person must choose. */
export const IDENTITY_DETAIL_FIELDS = [
  "date_of_birth", "passport_number", "passport_expiry_date", "itin_number", "itin", "itin_issue_date",
] as const

/** every contact column the report reads */
export const DETAIL_FIELDS: readonly string[] = [...IDENTITY_DETAIL_FIELDS, ...PLAIN_DETAIL_FIELDS, ...ADDRESS_FIELDS]

export const DETAIL_LABELS: Record<string, string> = {
  date_of_birth: "Date of birth", passport_number: "Passport number", passport_expiry_date: "Passport expiry",
  itin_number: "ITIN number", itin: "ITIN (second field)", itin_issue_date: "ITIN issue date",
  phone: "Phone", phone_2: "Phone 2", phone_3: "Phone 3", phone_4: "Phone 4", email_2: "Second email",
  citizenship: "Citizenship", residency: "Residency", gender: "Gender",
  address_line1: "Address",
}

export type DetailChoice = "loser" | "winner"
export type DetailStatus = "same" | "copy" | "conflict" | "only_kept"

export interface DetailRow {
  field: string
  label: string
  identity: boolean
  kept: string | null
  removed: string | null
  status: DetailStatus
  /** the field this date belongs to (passport number / ITIN number) */
  dependsOn?: string
}

/** '', spaces and NULL all mean "nothing there". */
export function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "")
}

/** Two writings of the same value compare equal: case, spaces and punctuation are ignored (same rule as the database). */
export function normalizeForCompare(v: unknown): string {
  return String(v ?? "").trim().replace(/[\s!-/:-@[-`{-~]/g, "")  // whitespace and ASCII punctuation (no unicode flag: the build target is ES5).toLowerCase()
}

function text(v: unknown): string | null {
  return isEmptyValue(v) ? null : String(v).trim()
}

function sameValue(k: string, r: string): boolean {
  const nk = normalizeForCompare(k)
  const nr = normalizeForCompare(r)
  return (nk !== "" && nk === nr) || k.toLowerCase() === r.toLowerCase()
}

function addressText(c: Record<string, unknown>): string | null {
  const parts = ADDRESS_FIELDS.map((f) => text(c[f])).filter((x): x is string => x !== null)
  return parts.length ? parts.join(", ") : null
}

/** One row per detail where at least one of the two contacts has a value (the address is one row). */
export function diffPersonalDetails(kept: Record<string, unknown>, removed: Record<string, unknown>): DetailRow[] {
  const rows: DetailRow[] = []
  const add = (field: string, identity: boolean, k: string | null, r: string | null) => {
    if (k === null && r === null) return
    let status: DetailStatus
    if (r === null) status = "only_kept"
    else if (k === null) status = "copy"
    else status = sameValue(k, r) ? "same" : "conflict"
    const row: DetailRow = { field, label: DETAIL_LABELS[field] ?? field, identity, kept: k, removed: r, status }
    if (DEPENDS_ON[field]) row.dependsOn = DEPENDS_ON[field]
    rows.push(row)
  }
  const keptPhones = PHONE_FIELDS.map((f) => text(kept[f])).filter((x): x is string => x !== null)
  for (const field of [...IDENTITY_DETAIL_FIELDS, ...PLAIN_DETAIL_FIELDS]) {
    const k = text(kept[field])
    const r = text(removed[field])
    // a number the kept contact already has in ANY phone slot is the same number, not something to copy again
    if ((PHONE_FIELDS as readonly string[]).includes(field) && r !== null && keptPhones.some((p) => sameValue(p, r))) {
      rows.push({ field, label: DETAIL_LABELS[field] ?? field, identity: false, kept: k ?? r, removed: r, status: "same" })
      continue
    }
    add(field, (IDENTITY_DETAIL_FIELDS as readonly string[]).includes(field), k, r)
  }
  add(ADDRESS_KEY, false, addressText(kept), addressText(removed))
  return rows
}

/** Identity details where the two differ and nobody has chosen yet: the merge cannot go ahead until they are chosen. */
export function unresolvedIdentityConflicts(rows: DetailRow[], choices: Record<string, string | undefined>): DetailRow[] {
  return rows.filter((r) => r.status === "conflict" && r.identity && choices[r.field] !== "loser" && choices[r.field] !== "winner")
}

/** Keep only well-formed choices for fields that are really conflicts or copies (anything else is dropped before the call). */
export function cleanChoices(rows: DetailRow[], raw: unknown): Record<string, DetailChoice> {
  const out: Record<string, DetailChoice> = {}
  if (!raw || typeof raw !== "object") return out
  const known = new Map(rows.map((r) => [r.field, r]))
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    const row = known.get(field)
    if (!row || (value !== "loser" && value !== "winner")) continue
    if (row.status === "conflict" || row.status === "copy") out[field] = value
  }
  return out
}

// ── Which contact stays ──────────────────────────────────────────────────────

export interface KeepCandidate {
  id: string
  email: string | null
  /** has a portal login that can sign in */
  workingLogin: boolean
  /** companies linked (account_contacts) */
  companies: number
  /** other linked records (a rough measure of how much history it holds) */
  records: number
}

export interface KeepSuggestion {
  keepId: string
  /** plain-English reasons, strongest first */
  reasons: string[]
  decidedBy: "wanted_email" | "working_login" | "most_data" | "tie"
}

/**
 * Rules in order: (1) the email the person wants, (2) the record with a working login, (3) the record with the most
 * companies / data. On a tie it keeps `fallbackKeepId` (the one the staff member picked).
 */
export function suggestKeep(a: KeepCandidate, b: KeepCandidate, wantedEmail: string | null | undefined, fallbackKeepId: string): KeepSuggestion {
  const wanted = (wantedEmail ?? "").trim().toLowerCase()
  if (wanted) {
    const aw = (a.email ?? "").trim().toLowerCase() === wanted
    const bw = (b.email ?? "").trim().toLowerCase() === wanted
    if (aw !== bw) {
      const win = aw ? a : b
      return { keepId: win.id, decidedBy: "wanted_email", reasons: [`It is the email the person wants to use (${win.email}).`] }
    }
  }
  if (a.workingLogin !== b.workingLogin) {
    const win = a.workingLogin ? a : b
    return { keepId: win.id, decidedBy: "working_login", reasons: ["It has a login that works. The other one does not, so keeping it avoids locking the person out."] }
  }
  if (a.companies !== b.companies || a.records !== b.records) {
    const win = a.companies !== b.companies ? (a.companies > b.companies ? a : b) : (a.records > b.records ? a : b)
    const lose = win === a ? b : a
    const why = win.companies !== lose.companies
      ? `It is linked to more companies (${win.companies} against ${lose.companies}).`
      : `It holds more linked records (${win.records} against ${lose.records}).`
    return { keepId: win.id, decidedBy: "most_data", reasons: [why] }
  }
  return { keepId: fallbackKeepId, decidedBy: "tie", reasons: ["The two look equal, so the one you picked stays."] }
}

// ── Documents with no owner ──────────────────────────────────────────────────

export interface OwnerlessDocCandidate {
  id: string
  category: number | null
  contact_id: string | null
  account_id: string | null
}

/** Personal documents (category 2) with no owner, on a company one of the two contacts belongs to. */
export function eligibleOwnerlessDocs<T extends OwnerlessDocCandidate>(docs: T[], companyIds: Iterable<string>): T[] {
  const companies = new Set(companyIds)
  return docs.filter((d) => d.account_id && companies.has(d.account_id) && isUnresolvedPersonalDocument({ category: d.category, contact_id: d.contact_id }))
}

/** Only ids that are really in the offered list reach the database (anything else is ignored). */
export function cleanDocumentIds(raw: unknown, offered: Array<{ id: string }>): string[] {
  if (!Array.isArray(raw)) return []
  const ok = new Set(offered.map((d) => d.id))
  return Array.from(new Set(raw.filter((x): x is string => typeof x === "string" && ok.has(x))))
}
