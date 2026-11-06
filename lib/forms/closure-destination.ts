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
  if (ein.length === 9) {
    const hits = candidates.filter((c) => digitsOnly(c.ein_number) === ein)
    if (hits.length === 1) return { status: "one", id: hits[0].id, by: "ein" }
    if (hits.length > 1) return { status: "ambiguous", ids: hits.map((h) => h.id) }
  }
  const name = normalizeCompanyName(typed.name)
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

/** The folder name Antonio asked for: "Company closure_<company name>". */
export function closureFolderName(llcName: unknown): string {
  const name = String(llcName ?? "").trim()
  return `Company closure_${name || "Unknown LLC"}`
}

/** The plain-English line for staff when the two checks disagree. */
export function disagreementText(d: ClosureDisagreement, names: { typed: string; linked: string | null; matched: string | null }): string {
  const typed = names.typed || "(nothing)"
  switch (d) {
    case "linked_no_match":
      return `This closure is linked to ${names.linked ?? "a company of ours"}, but the client wrote "${typed}" and that matches none of the person's companies. The documents were filed in the person's folder "${closureFolderName(typed)}" — check which company is being closed.`
    case "linked_other":
      return `This closure is linked to ${names.linked ?? "a company of ours"}, but the client wrote "${typed}", which matches ${names.matched ?? "a different company of ours"}. The documents were filed in the person's folder "${closureFolderName(typed)}" — check which company is being closed.`
    case "match_not_linked":
      return `The client wrote "${typed}", which is ${names.matched ?? "one of our companies"}, but this closure is not linked to it. The documents were filed in the person's folder "${closureFolderName(typed)}" — check whether it is our company that is being closed.`
    case "ambiguous":
      return `The client wrote "${typed}" and it matches more than one company of the person's. The documents were filed in the person's folder "${closureFolderName(typed)}" — check which company is being closed.`
  }
}

export interface ClosureDestination {
  /** a storage marker ("person-storage:…" / "account-storage:…") or, for a company still on Drive, its folder id — as resolveClosureFolder */
  folderId: string
  /** set when the package goes to the PERSON's storage: the folder directly under it ("Company closure_<name>") */
  storeRootSubFolder?: string
  kind: ClosureTarget["kind"]
  /** the plain-English "check this" line for staff, or null when everything agreed */
  disagreement: string | null
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
    if (folderId.startsWith("person-storage:")) return { folderId, storeRootSubFolder: closureFolderName(typedName), kind: "company", disagreement: null }
    return { folderId, kind: "company", disagreement: null }
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
  return { folderId, storeRootSubFolder: closureFolderName(typedName), kind: "other_company", disagreement }
}
