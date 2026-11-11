/**
 * Where a closure package is filed — decided by what the CLIENT WROTE in the closure wizard (company name + EIN), checked against the
 * job's own company link (Company Closure Part B, Antonio 2026-11-06; dev job a6bbea09).
 *
 * Why the wizard decides and the offer does not: an offer's company link is rewritten later (a formation bundle is made on a person and
 * gets the NEW company attached after the formation), and two of the three real closure jobs do not record their offer at all. The wizard
 * names the exact company at the moment we file. The job's explicit company link is kept as the cross-check.
 *
 *   - job linked to company X AND the wizard's EIN/name is X (one of this person's companies) → the company's storage (as before).
 *   - job not linked AND the wizard's EIN/name matches none of the person's companies → another company: a folder
 *     "Company closure_<name>" directly under the PERSON's storage.
 *   - anything else (the two disagree, or the match is ambiguous) → we do not guess: same person's folder, plus a plain-English line
 *     for staff saying what to check. Nothing is ever filed in a company's storage unless BOTH agree.
 *
 * Only the folder is decided here. Closing a company at the end of the job still comes from the job's explicit link and the ask-first
 * question — a typed name never closes anything.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { resolveClosureFolder } from "@/lib/forms/closure-folder"
import { parseStorageMarker } from "@/lib/crm-store/save-form"

export interface CompanyCandidate {
  id: string
  company_name: string | null
  ein_number: string | null
}

export type CompanyMatch =
  | { status: "one"; id: string; by: "ein" | "name" }
  | { status: "none" }
  | { status: "ambiguous"; ids: string[] }

export type ClosureDisagreement = "linked_no_match" | "linked_other" | "match_not_linked" | "ambiguous"

export type ClosureTarget =
  | { kind: "company"; accountId: string }
  | { kind: "other_company"; disagreement: ClosureDisagreement | null }

/** Digits only — an EIN is compared as nine digits however it was typed ("12-3456789", "12 3456789"). */
export function digitsOnly(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "")
}

// Legal-form words only. "Company" / "Co" stay: they can be the real name.
const LEGAL_SUFFIX = /\b(llc|l\s*l\s*c|pllc|lc|inc|incorporated|corp|corporation|ltd|limited)\b/g

/** A company name made comparable: case, accents, punctuation and the legal-form word ignored ("Datavora, L.L.C." = "datavora llc"). */
export function normalizeCompanyName(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(LEGAL_SUFFIX, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Which of THESE companies (the person's own, plus the one the job is linked to) did the client write? The EIN is exact digits and wins;
 * the name is the fallback. Several hits = ambiguous, never a pick. A name that normalises to nothing matches nothing.
 */
export function matchTypedCompany(typed: { name?: unknown; ein?: unknown }, candidates: CompanyCandidate[]): CompanyMatch {
  const ein = digitsOnly(typed.ein)
  const name = normalizeCompanyName(typed.name)
  if (ein.length === 9) {
    const hits = candidates.filter((c) => digitsOnly(c.ein_number) === ein)
    if (hits.length === 1) {
      // The EIN is exact and wins over a spelling of the name — EXCEPT when the name the client wrote is, word for word, ANOTHER of the person's
      // companies (the wizard pre-fills the linked company's name AND EIN; changing only half of the pair must not file company B's papers under A).
      const other = name ? candidates.filter((c) => c.id !== hits[0].id && normalizeCompanyName(c.company_name) === name) : []
      if (other.length > 0) return { status: "ambiguous", ids: [hits[0].id, ...other.map((o) => o.id)] }
      return { status: "one", id: hits[0].id, by: "ein" }
    }
    if (hits.length > 1) return { status: "ambiguous", ids: hits.map((h) => h.id) }
  }
  if (name) {
    const hits = candidates.filter((c) => normalizeCompanyName(c.company_name) === name)
    if (hits.length === 1) return { status: "one", id: hits[0].id, by: "name" }
    if (hits.length > 1) return { status: "ambiguous", ids: hits.map((h) => h.id) }
  }
  return { status: "none" }
}

/** The whole rule, pure. Only "both agree" reaches a company's storage. */
export function decideClosureTarget(p: { linkedAccountId: string | null; match: CompanyMatch }): ClosureTarget {
  const { linkedAccountId: linked, match } = p
  if (match.status === "ambiguous") return { kind: "other_company", disagreement: "ambiguous" }
  if (linked) {
    if (match.status === "one" && match.id === linked) return { kind: "company", accountId: linked }
    return { kind: "other_company", disagreement: match.status === "one" ? "linked_other" : "linked_no_match" }
  }
  return { kind: "other_company", disagreement: match.status === "one" ? "match_not_linked" : null }
}

const FOLDER_PREFIX = "Company closure_"

/**
 * The folder name Antonio asked for: "Company closure_<company name>" — in a form the store accepts. The store refuses "/" , "\\" and control
 * characters and anything over 255 characters (lib/crm-store/names.ts), and a refused name aborts the whole filing — "24/7 Rentals LLC" could
 * never be filed. Same rule as `storeSafeFolderName` (lib/crm-store/formation-pilot.ts): those characters become "-".
 */
export function closureFolderName(llcName: unknown): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what the store refuses
  const safe = String(llcName ?? "").replace(/[\\/\u0000-\u001f\u007f]/g, "-").replace(/\s+/g, " ").trim()
  return `${FOLDER_PREFIX}${safe || "Unknown LLC"}`.slice(0, 255).trimEnd()
}

/** True when two company names are the same company once case, punctuation and the legal-form word are ignored. */
function sameCompanyName(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeCompanyName(a)
  return x !== "" && x === normalizeCompanyName(b)
}

/** The plain-English line for staff when the two checks disagree. */
export function disagreementText(d: ClosureDisagreement, names: { typed: string; linked: string | null; matched: string | null }): string {
  const typed = names.typed || "(nothing)"
  const folder = closureFolderName(typed)
  const linked = names.linked ?? "a company of ours"
  // "which is X" would repeat itself when the client simply wrote the company's own name
  const whichIs = (fallback: string) => (names.matched && !sameCompanyName(typed, names.matched) ? `which is ${names.matched}` : fallback)
  switch (d) {
    case "linked_no_match":
      return `This closure is linked to ${linked}, but the client wrote "${typed}" and that matches none of the person's companies. The documents were filed in the person's folder "${folder}" — check which company is being closed.`
    case "linked_other":
      return `This closure is linked to ${linked}, but the client wrote "${typed}", ${whichIs("one of the person's other companies")}. The documents were filed in the person's folder "${folder}" — check which company is being closed.`
    case "match_not_linked":
      return `The client wrote "${typed}", ${whichIs("one of our companies")}, but this closure is not linked to it. The documents were filed in the person's folder "${folder}" — check whether it is our company that is being closed.`
    case "ambiguous":
      return `The client wrote "${typed}" and it matches more than one company of the person's. The documents were filed in the person's folder "${folder}" — check which company is being closed.`
  }
}

/**
 * A job linked to a company of ours, where the client wrote that company's NAME (so the job moves on) but a DIFFERENT 9-digit EIN than our record has:
 * the move is right (names are matched on purpose — spelling and legal-form variants), but nobody should discover the difference only at the letter box.
 * Returns one plain sentence for the job's staff notes, or null when there is nothing to say: no company, an EIN that agrees, our record having no
 * EIN, or a client's number that is not nine digits (a typo is the client's to finish, not a conflict). A job with NO company never reaches this —
 * there is no "our EIN" to compare with, and any EIN is simply what the client wrote.
 */
export function einDifferenceNote(p: { typedEin: unknown; linked: CompanyCandidate | null | undefined }): string | null {
  const typed = digitsOnly(p.typedEin)
  const ours = digitsOnly(p.linked?.ein_number)
  if (!p.linked || typed.length !== 9 || ours.length !== 9 || typed === ours) return null
  const company = p.linked.company_name ?? "this company"
  return `The client wrote EIN ${String(p.typedEin).trim()} for ${company}, but our record has EIN ${p.linked.ein_number}. The job was moved on because the company name matches. The EIN letter will use our record — if the client's number is the right one, the company record needs correcting.`
}

/**
 * A correction must not change WHERE the package already is: the saver keeps a replayed package in the folder its summary was first filed in
 * (lib/crm-store/save-form.ts), so a corrected company name must not make the job's note / the pinned plan name a folder that does not exist.
 * `prior` is the folder name pinned by the first pass; it wins when both are person folders.
 */
export function keepFirstFolderName(prior: unknown, next: string | undefined): string | undefined {
  if (!next) return next
  return typeof prior === "string" && prior.startsWith(FOLDER_PREFIX) ? prior : next
}

export interface ClosureDestination {
  /** a storage marker ("person-storage:…" / "account-storage:…") or, for a company still on Drive, its folder id — as resolveClosureFolder */
  folderId: string
  /** set when the package goes to the PERSON's storage: the folder directly under it ("Company closure_<name>") */
  storeRootSubFolder?: string
  kind: ClosureTarget["kind"]
  /** the plain-English "check this" line for staff, or null when everything agreed */
  disagreement: string | null
  /** a plain note for staff that does NOT hold the job (the client's EIN differs from our record although the company name matches), or null */
  note: string | null
  /**
   * The owner id the saver puts in the stored files' keys (`form-summary:<owner>:closure:<token>`): the person for "person-storage:…", the
   * company for "account-storage:…" AND for a company that kept a Drive folder id (the saver then redirects the files into the company's
   * storage — 262 of the 275 companies with live storage on production still have one). Used to find the files again; null = not a storage.
   */
  storageOwnerId: string | null
}

/** The person's companies plus the job's linked one, as comparable candidates. THROWS on a read error (the caller retries). */
async function loadCandidates(contactId: string | null, linkedAccountId: string | null): Promise<CompanyCandidate[]> {
  const ids = new Set<string>()
  if (contactId) {
    const { data, error } = await supabaseAdmin.from("account_contacts").select("account_id").eq("contact_id", contactId)
    if (error) throw new Error(`closure destination: could not read the person's companies (retryable): ${error.message}`)
    for (const r of data ?? []) if (r.account_id) ids.add(r.account_id as string)
  }
  if (linkedAccountId) ids.add(linkedAccountId)
  if (ids.size === 0) return []
  const { data, error } = await supabaseAdmin.from("accounts").select("id, company_name, ein_number").in("id", Array.from(ids))
  if (error) throw new Error(`closure destination: could not read the companies (retryable): ${error.message}`)
  return (data ?? []) as CompanyCandidate[]
}

/**
 * Decide where this closure's package goes. `linkedAccountId` is the job's (or the submission's) explicit company link — never inferred
 * from the person. THROWS on a read error and when there is nowhere to file (loud, so the alarm fires — never a silent skip).
 */
export async function resolveClosureDestination(p: {
  linkedAccountId: string | null
  contactId: string | null
  clientName: string
  submittedData: Record<string, unknown>
}): Promise<ClosureDestination> {
  const typedName = String(p.submittedData.llc_name ?? "").trim()
  const candidates = await loadCandidates(p.contactId, p.linkedAccountId)
  const match = matchTypedCompany({ name: typedName, ein: p.submittedData.llc_ein }, candidates)
  const target = decideClosureTarget({ linkedAccountId: p.linkedAccountId, match })

  if (target.kind === "company") {
    const folderId = await resolveClosureFolder({ accountId: target.accountId, contactId: p.contactId, clientName: p.clientName })
    // The company has no storage of its own yet, so the answer is the PERSON's storage: keep the package tidy in its own folder instead of
    // mixing it into "Personal documents" (no disagreement — the company IS the one being closed).
    const marker = parseStorageMarker(folderId)
    const note = einDifferenceNote({ typedEin: p.submittedData.llc_ein, linked: candidates.find((c) => c.id === target.accountId) })
    if (marker?.kind === "contact") return { folderId, storeRootSubFolder: closureFolderName(typedName), kind: "company", disagreement: null, note, storageOwnerId: marker.id }
    // "account-storage:<id>" or the company's Drive folder id (which the saver turns into the company's storage): the company owns the files.
    return { folderId, kind: "company", disagreement: null, note, storageOwnerId: target.accountId }
  }

  // Another company (or a disagreement): the PERSON's storage, never a company's.
  const folderId = await resolveClosureFolder({ accountId: null, contactId: p.contactId, clientName: p.clientName })
  const nameOf = (id: string | null) => candidates.find((c) => c.id === id)?.company_name ?? null
  const disagreement = target.disagreement
    ? disagreementText(target.disagreement, {
        typed: typedName,
        linked: nameOf(p.linkedAccountId),
        matched: match.status === "one" ? nameOf(match.id) : null,
      })
    : null
  return { folderId, storeRootSubFolder: closureFolderName(typedName), kind: "other_company", disagreement, note: null, storageOwnerId: parseStorageMarker(folderId)?.id ?? null }
}
