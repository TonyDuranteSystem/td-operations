/**
 * Prior-year carry-forward + staff correction (dev_task dd26c22f / d909e086).
 *
 * The Dynamiq trap: a client's filed prior-year return can be "validated"
 * (readable, internally consistent) while being factually WRONG — the system
 * had no way to (a) offer the client's own corrected books as a better source,
 * or (b) let staff directly enter the true figures when they already know
 * them. This module is that missing piece, shared by BOTH real client
 * accounts (tax_return_submissions.prior_return_extracted) and the standalone
 * staff workspace tool (pnl_workspaces.prior_return_snapshot) — confirmed both
 * are real client-facing delivery paths (round-3 finding), so neither can be
 * left out.
 *
 * Three rounds of adversarial bug-hunter review shaped this design:
 *  - NEVER live-recompute on a passive read (round-2 blocker) — every write
 *    here happens exactly once, at an explicit staff action.
 *  - NEVER silently override an already-authoritative answer (round-2
 *    blocker) — computeCarryFromBooks only OFFERS a candidate; the caller
 *    decides whether the current prior_return_extracted is eligible to be
 *    auto-replaced (see the API routes) BEFORE calling this.
 *  - NEVER let checking "is N-1 trustworthy" have side effects — this always
 *    calls getFinancialsView with skipOwnershipSync:true.
 *  - Member matching is contact_id-first (survives a display-name change),
 *    name fallback (existing sameName logic, for either side lacking a link).
 *    A member matched by neither is named in unresolved_members, never
 *    silently given 0 with no signal (gate 7 in verification-gates.ts reads
 *    this).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { getFinancialsView } from "./financials-orchestration"
import { sameName, normalizeName, type ResolvedMember } from "./ownership-resolution"
import { buildCarriedForwardRecord, type CarryMemberLink, type CarryPayload, type PriorReturnCaseRecord } from "./prior-return-case"

export interface CarryCheckResult {
  offered: boolean
  /** Set when offered=false — a plain-English reason to show staff. */
  reason?: string
  /** Set when offered=true — ready to write as-is, or to show as a preview. */
  candidate?: PriorReturnCaseRecord
  priorYear: number
}

/**
 * Is there a usable, trustworthy prior year (priorYear = taxYear - 1) to
 * carry beginning balances FROM, for this account? Read-only — never writes,
 * never syncs ownership. `currentMembers` is the CALLER's already-resolved
 * roster for `taxYear` (the account's own ownership.members, or a linked
 * workspace's) — passed in rather than re-resolved here, since the caller
 * already has it from its own getFinancialsView/getWorkspaceFinancialsView
 * call and re-deriving it here would be redundant I/O.
 */
export async function computeCarryFromBooks(
  accountId: string,
  taxYear: number,
  currentMembers: ResolvedMember[],
): Promise<CarryCheckResult> {
  const priorYear = taxYear - 1

  const { count } = await supabaseAdmin
    .from("bank_transactions")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .eq("tax_year", priorYear)
  if (!count || count === 0) {
    return { offered: false, reason: `No transactions on file for ${priorYear} — nothing to carry from.`, priorYear }
  }

  const priorView = await getFinancialsView(accountId, priorYear, { skipOwnershipSync: true })
  const { draft, gates, ownership } = priorView

  // Trustworthiness gate — stricter than a bare "$1 balance tolerance"
  // (round-2 finding): reconciliation must not be actively broken, the
  // balance sheet must genuinely tie, AND ownership must be fully resolved
  // (round-3 major — gate 1+3 alone can pass "cleanly" on a year where
  // ownership never really resolved, since beginning cash and per-member
  // capital both collapse to a degenerate 0-member state in that case).
  const gate1 = gates.find(g => g.id === 1)
  const gate3 = gates.find(g => g.id === 3)
  const gate5 = gates.find(g => g.id === 5)
  if (gate1?.status === "fail") {
    return { offered: false, reason: `${priorYear}'s statement reconciliation doesn't check out yet — resolve that before carrying forward.`, priorYear }
  }
  if (gate3?.status !== "pass") {
    return { offered: false, reason: `${priorYear}'s balance sheet doesn't balance yet — resolve that before carrying forward.`, priorYear }
  }
  if (gate5?.status !== "pass" || !ownership.complete || ownership.members.length === 0) {
    return { offered: false, reason: `${priorYear}'s ownership isn't fully resolved yet — confirm ownership percentages before carrying forward.`, priorYear }
  }
  if (draft.beginning_cash === null) {
    return { offered: false, reason: `${priorYear} has no resolved beginning cash of its own to carry from.`, priorYear }
  }

  const priorEndingByName = new Map(draft.members.map(m => [m.name, m.ending_capital]))
  const members: CarryMemberLink[] = []
  const unresolvedMembers: string[] = []
  // A prior-year member can be claimed by at most ONE current member. Without
  // this, sameName's subset match (round-4 bug-hunter major: "Maria Rossi" vs
  // a NEW current member "Maria Rossi Bianchi") lets a name-superset
  // collision match the SAME prior person twice — both current members would
  // silently receive an identical beginning_capital, double-counting real
  // money. Three passes, most-confident first, so array order can never
  // decide who wins a genuine tie: (1) contact_id — a real id match is never
  // in doubt; (2) EXACT normalized name — also never ambiguous; (3) fuzzy
  // subset match (sameName) among whatever prior members are STILL
  // unclaimed. A member racing for an already-claimed prior entry at any
  // stage is UNRESOLVED, never a silent duplicate.
  const claimed = new Set<string>()
  const matchOf = new Map<string, ResolvedMember>()
  for (const m of currentMembers) {
    if (!m.contact_id || matchOf.has(m.name)) continue
    // round-5 bug-hunter major: this pass was missing the SAME !claimed.has
    // guard passes 2/3 already carry — two current members sharing one
    // (data-integrity-bug) contact_id both matched the same prior member and
    // both silently received their capital, reopening double-counting via a
    // different vector than the one this three-pass rewrite was built to close.
    const p = ownership.members.find(x => !claimed.has(x.name) && x.contact_id === m.contact_id)
    if (p) { matchOf.set(m.name, p); claimed.add(p.name) }
  }
  for (const m of currentMembers) {
    if (matchOf.has(m.name)) continue
    const p = ownership.members.find(x => !claimed.has(x.name) && normalizeName(x.name) === normalizeName(m.name))
    if (p) { matchOf.set(m.name, p); claimed.add(p.name) }
  }
  for (const m of currentMembers) {
    if (matchOf.has(m.name)) continue
    const p = ownership.members.find(x => !claimed.has(x.name) && sameName(x.name, m.name))
    if (p) { matchOf.set(m.name, p); claimed.add(p.name) }
  }
  for (const m of currentMembers) {
    const priorMatch = matchOf.get(m.name)
    const endingCapital = priorMatch ? priorEndingByName.get(priorMatch.name) : undefined
    if (!priorMatch || endingCapital === undefined) {
      unresolvedMembers.push(m.name)
      continue
    }
    members.push({ contact_id: m.contact_id, name: m.name, beginning_capital: endingCapital })
  }

  const payload: CarryPayload = {
    beginning_cash: draft.ending_cash,
    beginning_cta: draft.ending_cta,
    members,
    unresolved_members: unresolvedMembers,
  }
  return { offered: true, candidate: buildCarriedForwardRecord(payload, priorYear, new Date().toISOString()), priorYear }
}

/** Case/status an EXISTING prior_return_extracted/prior_return_snapshot must
 *  be in for the AUTOMATIC carry (computeCarryFromBooks's candidate) to be
 *  allowed to auto-write over it — absent, a prior failed attempt, or a
 *  we_filed answer we could never auto-read. Deliberately narrow (round-2
 *  blocker: "ties" was not the same as "authoritative") — never true for an
 *  already-validated upload, a first_year/never_filed declaration, or an
 *  existing carried_forward/staff_corrected record (re-carrying over a
 *  standing answer is a deliberate staff action, not an automatic one).
 *  The MANUAL staff-correction path is exempt from this check entirely — see
 *  the API route, which never calls this function. */
export function autoCarryMayReplace(existing: PriorReturnCaseRecord | null): boolean {
  if (!existing) return true
  if (existing.status === "failed") return true
  return existing.case === "we_filed" && existing.status === "on_file"
}

export type ValidatedCorrectionPayload = { beginning_cash: number; beginning_cta: number; members: CarryMemberLink[] }

/**
 * Shared request-body validator for BOTH the account-side and workspace-side
 * manual-correction routes. Every numeric field is REQUIRED — none is
 * defaulted here or by any caller (round-2 finding: a silently-defaulted
 * blank field risks discarding a previously-correct value through the "fix"
 * door instead of the "bug" door). PURE — no I/O, easy to unit test.
 */
export function validateCorrectionPayload(body: unknown): { ok: true; value: ValidatedCorrectionPayload } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Request body required." }
  const b = body as Record<string, unknown>
  if (typeof b.beginning_cash !== "number" || !Number.isFinite(b.beginning_cash)) return { ok: false, error: "beginning_cash is required and must be a number." }
  if (typeof b.beginning_cta !== "number" || !Number.isFinite(b.beginning_cta)) return { ok: false, error: "beginning_cta is required and must be a number (0 if there is none to carry)." }
  if (!Array.isArray(b.members) || b.members.length === 0) return { ok: false, error: "members is required and must list every currently-active member." }
  const members: CarryMemberLink[] = []
  for (const raw of b.members) {
    if (typeof raw !== "object" || raw === null) return { ok: false, error: "Each member entry must be an object." }
    const m = raw as Record<string, unknown>
    if (typeof m.name !== "string" || m.name.trim().length === 0) return { ok: false, error: "Each member requires a name." }
    if (typeof m.beginning_capital !== "number" || !Number.isFinite(m.beginning_capital)) return { ok: false, error: `beginning_capital is required for ${m.name} — enter 0 explicitly if that member's true opening capital is zero.` }
    if (m.contact_id !== null && m.contact_id !== undefined && typeof m.contact_id !== "string") return { ok: false, error: `contact_id for ${m.name} must be a string or null.` }
    members.push({ contact_id: (m.contact_id as string | null | undefined) ?? null, name: m.name, beginning_capital: m.beginning_capital })
  }
  return { ok: true, value: { beginning_cash: b.beginning_cash, beginning_cta: b.beginning_cta, members } }
}
