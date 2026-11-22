/**
 * The merge REPORT (dev job 938af003, slice 1): both contacts side by side, which one is suggested to stay, the field-by-field
 * difference in personal details, the personal documents with no owner, and the login state of both. Reads only — the
 * dry run never writes. The merge itself is `merge_contacts` run by the delete-contact route.
 *
 * Split in two: `loadMergeRaw` reads the database, `assembleMergeReport` is pure (tests cover it).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  DETAIL_FIELDS, countFilledDetails, diffPersonalDetails, eligibleOwnerlessDocs, suggestKeep, unresolvedIdentityConflicts,
  type DetailRow, type KeepSuggestion,
} from "@/lib/contacts/merge-details"
import { storeMergeCheck } from "@/lib/crm-store/merge-guard"
import { summarizePlan, type CombinePlan, type PlanSummary } from "@/lib/crm-store/merge-combine"
import { memberRowsOf } from "@/lib/operations/contact-name-follow"
import { sharedMemberAccounts } from "@/lib/operations/contact-merge-preview"
import { getContactReferenceReport } from "@/lib/operations/contact-reference"
import type { User } from "@supabase/supabase-js"

export interface LoginView {
  id: string
  email: string | null
  /** can sign in: not banned and the address was confirmed or has been used */
  working: boolean
  lastSignInAt: string | null
}

export interface RawContact {
  id: string
  full_name: string | null
  email: string | null
  alt_emails: string[] | null
  merged_into: string | null
  passport_on_file: boolean | null
  portal_tier: string | null
  [detail: string]: unknown
}

export interface RawDoc {
  id: string
  file_name: string | null
  document_type_name: string | null
  category: number | null
  contact_id: string | null
  account_id: string | null
  account_name: string | null
  portal_visible: boolean | null
}

export interface RawCompany { id: string; name: string; status: string | null }

export interface MergeRaw {
  removed: RawContact
  kept: RawContact
  companies: { removed: RawCompany[]; kept: RawCompany[] }
  records: { removed: number; kept: number }
  logins: { removed: LoginView[]; kept: LoginView[] }
  hasStorage: { removed: boolean; kept: boolean }
  /** every personal (category 2) document with no owner, on the companies of either contact */
  ownerlessDocs: RawDoc[]
  /** documents the removed contact owns (they move to the kept one by themselves) */
  removedOwnedDocs: number
  /** blocker messages from the checks the merge itself runs (storages, same owner twice, already merged...) */
  blockers: string[]
  wantedEmail: string | null
  /** both contacts have their own storage and the merge will combine them: what it will do (null = nothing to combine) */
  storagePlan: CombinePlan | null
}

export interface PersonView {
  id: string
  fullName: string | null
  email: string | null
  companies: RawCompany[]
  records: number
  logins: LoginView[]
  hasStorage: boolean
  passportOnFile: boolean | null
}

export interface MergeReport {
  removed: PersonView
  kept: PersonView
  suggestion: KeepSuggestion
  /** the suggestion differs from the contact currently set to stay */
  suggestsSwap: boolean
  details: DetailRow[]
  /** identity details that differ: the person must choose before the merge can run */
  identityToChoose: string[]
  documents: {
    ownerless: Array<{ id: string; fileName: string | null; documentType: string | null; companyName: string | null; portalVisible: boolean }>
    /** companies that have another linked person besides these two: such a document might belong to them */
    movingFromRemoved: number
  }
  blockers: string[]
  /** the combine of the two Storage folders, in plain English (null when the storages are not combined) */
  storage: { plan: CombinePlan; summary: PlanSummary } | null
}

function view(c: RawContact, companies: RawCompany[], records: number, logins: LoginView[], hasStorage: boolean): PersonView {
  return { id: c.id, fullName: c.full_name, email: c.email, companies, records, logins, hasStorage, passportOnFile: c.passport_on_file }
}

export function assembleMergeReport(raw: MergeRaw): MergeReport {
  const removed = view(raw.removed, raw.companies.removed, raw.records.removed, raw.logins.removed, raw.hasStorage.removed)
  const kept = view(raw.kept, raw.companies.kept, raw.records.kept, raw.logins.kept, raw.hasStorage.kept)

  const details = diffPersonalDetails(raw.kept, raw.removed)
  const identityToChoose = unresolvedIdentityConflicts(details, {}).map((r) => r.field)

  const companyIds = [...raw.companies.removed, ...raw.companies.kept].map((c) => c.id)
  const docs = eligibleOwnerlessDocs(raw.ownerlessDocs, companyIds)

  const cand = (p: PersonView, c: RawContact) => ({ id: p.id, email: p.email, workingLogin: p.logins.some((l) => l.working), companies: p.companies.length, details: countFilledDetails(c), records: p.records })
  const suggestion = suggestKeep(cand(kept, raw.kept), cand(removed, raw.removed), raw.wantedEmail, kept.id)

  return {
    removed, kept, suggestion,
    suggestsSwap: suggestion.keepId !== kept.id,
    details, identityToChoose,
    documents: {
      ownerless: docs.map((d) => ({ id: d.id, fileName: d.file_name, documentType: d.document_type_name, companyName: d.account_name, portalVisible: !!d.portal_visible })),
      movingFromRemoved: raw.removedOwnedDocs,
    },
    blockers: raw.blockers,
    storage: raw.storagePlan && summarizePlan(raw.storagePlan) ? { plan: raw.storagePlan, summary: summarizePlan(raw.storagePlan) as PlanSummary } : null,
  }
}

function toLoginViews(users: User[]): LoginView[] {
  return users.map((u) => {
    const bannedUntil = (u as unknown as { banned_until?: string | null }).banned_until
    const banned = !!bannedUntil && new Date(bannedUntil).getTime() > Date.now()
    return { id: u.id, email: u.email ?? null, lastSignInAt: u.last_sign_in_at ?? null, working: !banned && !!(u.email_confirmed_at || u.last_sign_in_at) }
  })
}

async function companiesOf(contactId: string): Promise<RawCompany[]> {
  const { data: links } = await supabaseAdmin.from("account_contacts").select("account_id").eq("contact_id", contactId)
  const ids = (links ?? []).map((l) => l.account_id as string)
  if (ids.length === 0) return []
  const { data: accts } = await supabaseAdmin.from("accounts").select("id, company_name, status").in("id", ids)
  return (accts ?? []).map((a) => ({ id: a.id as string, name: (a.company_name as string) ?? "(no name)", status: (a.status as string | null) ?? null }))
}

async function recordCount(contactId: string): Promise<number> {
  return (await getContactReferenceReport(contactId)).total_blocking
}

async function hasStorageOwner(contactId: string): Promise<boolean> {
  const { count } = await supabaseAdmin.from("store_owners").select("id", { count: "exact", head: true }).eq("contact_id", contactId)
  return (count ?? 0) > 0
}

/** Everything the report needs, read fresh. Returns a message instead when the pair cannot be shown at all. */
export interface MergeRawOptions {
  /** already read by the caller (saves a slow call) */
  removedRecords?: number
  /** logins of the two contacts, already read in ONE scan (contact id -> logins) */
  users?: Map<string, User[]>
}

export async function loadMergeRaw(removedId: string, keptId: string, wantedEmail: string | null, opts: MergeRawOptions = {}): Promise<MergeRaw | { error: string }> {
  if (removedId === keptId) return { error: "A contact cannot be merged into itself." }
  const cols = ["id", "full_name", "email", "alt_emails", "merged_into", "passport_on_file", "portal_tier", ...DETAIL_FIELDS].join(", ")
  const { data: pair, error } = await supabaseAdmin.from("contacts").select(cols).in("id", [removedId, keptId])
  if (error) return { error: `Could not read the two contacts: ${error.message}` }
  const rows = (pair ?? []) as unknown as RawContact[]
  const removed = rows.find((c) => c.id === removedId)
  const kept = rows.find((c) => c.id === keptId)
  if (!removed || !kept) return { error: "One of the two contacts was not found." }

  const blockers: string[] = []
  if (kept.merged_into) blockers.push(`"${kept.full_name}" was already merged into another contact — choose the one that is kept.`)
  if (removed.merged_into) blockers.push(`"${removed.full_name}" was already merged into another contact.`)
  const storeCheck = await storeMergeCheck(removedId, keptId)
  if (storeCheck.blocker) blockers.push(storeCheck.blocker)
  const [removedMembers, keptMembers] = await Promise.all([memberRowsOf(removedId), memberRowsOf(keptId)])
  const shared = sharedMemberAccounts(removedMembers, keptMembers)
  if (shared.length > 0) {
    const { data: accts } = await supabaseAdmin.from("accounts").select("company_name").in("id", shared)
    blockers.push(`Both contacts are listed as owners of ${(accts ?? []).map((a) => a.company_name).join(", ")}. Remove the duplicate owner entry there first, then merge.`)
  }

  let users = opts.users
  if (!users) {
    const { findAuthUsersByContactIds } = await import("@/lib/auth-admin-helpers")
    users = await findAuthUsersByContactIds([removedId, keptId]).catch(() => new Map<string, User[]>())
  }
  const [cRem, cKept, rRem, rKept, sRem, sKept] = await Promise.all([
    companiesOf(removedId), companiesOf(keptId),
    opts.removedRecords !== undefined ? Promise.resolve(opts.removedRecords) : recordCount(removedId), recordCount(keptId),
    hasStorageOwner(removedId), hasStorageOwner(keptId),
  ])
  const lRem = toLoginViews(users.get(removedId) ?? [])
  const lKept = toLoginViews(users.get(keptId) ?? [])

  const companyIds = Array.from(new Set([...cRem, ...cKept].map((c) => c.id)))
  let ownerlessDocs: RawDoc[] = []
  if (companyIds.length > 0) {
    const { data: docs } = await supabaseAdmin
      .from("documents")
      .select("id, file_name, document_type_name, category, contact_id, account_id, account_name, portal_visible")
      .eq("category", 2).is("contact_id", null).in("account_id", companyIds).order("created_at", { ascending: true })
    ownerlessDocs = (docs ?? []) as RawDoc[]
  }
  const { count: removedOwnedDocs } = await supabaseAdmin.from("documents").select("id", { count: "exact", head: true }).eq("contact_id", removedId)

  return {
    removed, kept,
    companies: { removed: cRem, kept: cKept },
    records: { removed: rRem, kept: rKept },
    logins: { removed: lRem, kept: lKept },
    hasStorage: { removed: sRem, kept: sKept },
    ownerlessDocs, removedOwnedDocs: removedOwnedDocs ?? 0, blockers, wantedEmail, storagePlan: storeCheck.plan,
  }
}

export async function buildMergeReport(removedId: string, keptId: string, wantedEmail: string | null, opts: MergeRawOptions = {}): Promise<MergeReport | { error: string }> {
  const raw = await loadMergeRaw(removedId, keptId, wantedEmail, opts)
  if ("error" in raw) return raw
  return assembleMergeReport(raw)
}
