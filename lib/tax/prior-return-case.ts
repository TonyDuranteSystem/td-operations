/**
 * Prior-year return case processing (Slice 6b, master plan §5).
 *
 * Runs after a tax wizard submission lands. Takes the client's answer to the
 * prior-return matrix and resolves it into a stored record on the submission
 * row (prior_return_extracted JSONB) — including the actual extraction when a
 * return was uploaded (Case B). Fire-and-forget from the submit route: a
 * failure here NEVER blocks the submission; it stores a failure record staff
 * can see.
 *
 * Cases:
 *  A we_filed        → verify tax_returns has a 'TR Filed' row for prior year;
 *                      mismatch (client says we filed, we have no record) is
 *                      flagged for staff, never silently trusted.
 *  B filed_elsewhere → download the uploaded PDF → extractPriorReturn →
 *                      validated | quarantined (staff reviews quarantines).
 *  C first_year      → cross-check the claim against accounts.formation_date
 *                      (§13 A6); a company formed BEFORE the tax year gets a
 *                      staff flag.
 *  D never_filed     → store the declaration (timestamped) or, if the client
 *                      wants the back-filing, create the staff task for a
 *                      quote (upsell rail).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { defaultTaskAssignee } from "@/lib/tasks/default-assignee"
import {
  detectPriorReturnOnFile,
  extractPriorReturn,
  locateAndExtractOurFiledReturn,
  type PriorReturnRecord,
  type PriorReturnExtraction,
  type PriorReturnValidationIssue,
} from "./prior-return-extract"

const UPLOAD_BUCKET = "onboarding-uploads" // same bucket as all portal wizard uploads

/** Discriminated union stored in tax_return_submissions.prior_return_extracted.
 *  we_filed gains `validated` / `quarantined` (auto-carry-forward): when WE
 *  filed the prior return, the system reads its Schedule L / K-1s from our own
 *  filed PDF and feeds the current year's beginning balances — see
 *  locateAndExtractOurFiledReturn. `on_file` = we have the record but couldn't
 *  auto-read it (staff tie out, the original behavior). */
/** A member match made when building a carried/corrected record — kept for
 *  audit/UI display alongside the name-keyed `extracted.k1s` the engine
 *  actually reads (round-3 bug-hunter blocker: the one chokepoint accessor,
 *  validatedExtraction below, only understands `.extracted` — so a carried/
 *  corrected record MUST populate it faithfully rather than inventing a
 *  parallel shape the engine can't see). contact_id is null when the match
 *  fell back to name (no linked account_contacts row on either side). */
export interface CarryMemberLink {
  contact_id: string | null
  name: string
  beginning_capital: number
}

/** Input to buildCarriedForwardRecord/buildStaffCorrectionRecord — PURE data,
 *  no I/O. `unresolved_members` are names of THIS year's currently-active
 *  members that could not be matched (by id or name) against the prior
 *  year's ending state; they are deliberately EXCLUDED from `members` (so
 *  their beginning capital falls through to the engine's existing 0-fallback)
 *  and named here so gate 7 (verification-gates.ts) can flag them instead of
 *  the silent zero passing unnoticed. */
export interface CarryPayload {
  beginning_cash: number
  /** Cumulative FX/CTA position carried in from the prior year — 0 when the
   *  prior year never tracked one (first adoption; see financials-engine.ts
   *  ending_cta). Always a real number, never omitted — silence here must
   *  never be misread as "confirmed zero" (round-3 bug-hunter major). */
  beginning_cta: number
  members: CarryMemberLink[]
  unresolved_members: string[]
}

export type PriorReturnCaseRecord =
  | (PriorReturnRecord & { case: "filed_elsewhere" })
  | { case: "we_filed"; status: "on_file" | "claim_mismatch"; tax_return_id: string | null; note: string; recorded_at: string }
  | { case: "we_filed"; status: "validated" | "quarantined"; tax_return_id: string | null; note: string; recorded_at: string; extracted: PriorReturnExtraction; issues: PriorReturnValidationIssue[]; source: string }
  | { case: "first_year"; status: "first_year" | "claim_mismatch"; formation_date: string | null; note: string; recorded_at: string }
  | { case: "never_filed"; status: "never_filed"; cleanup_interest: "Yes" | "No"; declaration_accepted: boolean; recorded_at: string }
  // Two DISTINCT cases (never reuse "we_filed" — round-2 bug-hunter finding:
  // that shape/label is honestly "we found a filed PDF", which a synthesized
  // or staff-typed figure is not, and gate 2 would print a misleading "last
  // year's return shows..." for a number that was never on any return).
  // carried_forward = system-computed from OUR OWN corrected prior-year books,
  // offered to and confirmed by staff (never auto-applied silently — see
  // prior-return-correction.ts). staff_corrected = a human directly enters
  // the true figures, e.g. because a filed return is known to be wrong. Both
  // deliberately reuse status "validated" + the `extracted` shape so the ONE
  // existing accessor below (and therefore priorEndingCash/priorBeginningCapital
  // and every ownership K-1 source) works on them with ZERO changes — the new
  // fields alongside `extracted` are read only by the new gate 7 / CTA plumbing.
  | { case: "carried_forward"; status: "validated"; recorded_at: string; extracted: PriorReturnExtraction; source: "our_corrected_books"; note: string; beginning_cta: number; member_links: CarryMemberLink[]; unresolved_members: string[]; computed_by: "system"; computed_at: string }
  | { case: "staff_corrected"; status: "validated"; recorded_at: string; extracted: PriorReturnExtraction; source: "staff_manual_correction"; note: string; beginning_cta: number; member_links: CarryMemberLink[]; unresolved_members: string[]; computed_by: string; computed_at: string }
  | { case: string; status: "failed"; error: string; recorded_at: string }

/** The validated prior-return extraction, from ANY trustworthy source (a
 *  client upload in filed_elsewhere, OUR own filed return in we_filed, a
 *  system-computed carry in carried_forward, or a staff-entered correction in
 *  staff_corrected). Single accessor so the engine + gates read every source
 *  identically. PURE. */
export function validatedExtraction(prior: PriorReturnCaseRecord | null): PriorReturnExtraction | null {
  if (!prior || prior.status !== "validated") return null
  if (prior.case === "filed_elsewhere" || prior.case === "we_filed" || prior.case === "carried_forward" || prior.case === "staff_corrected") {
    return (prior as { extracted?: PriorReturnExtraction }).extracted ?? null
  }
  return null
}

/** The cumulative FX/CTA position to feed buildFinancialDraft's beginningCta —
 *  0 for every case except carried_forward/staff_corrected (every other case
 *  predates the concept, so 0 is the honest "no known prior position", not a
 *  guess). PURE. */
export function priorBeginningCta(prior: PriorReturnCaseRecord | null): number {
  if (!prior || prior.status !== "validated") return 0
  if (prior.case === "carried_forward" || prior.case === "staff_corrected") return prior.beginning_cta
  return 0
}

/** PURE: turn a CarryPayload into the PriorReturnExtraction shape the engine
 *  already reads (schedule_l ending cash/capital, k1s by name). The
 *  `beginning` column is always zeroed — nothing downstream reads it for
 *  these two cases (only `ending` feeds priorEndingCash/priorBeginningCapital)
 *  and a fabricated non-zero beginning would misrepresent a figure nobody
 *  computed. */
function toPriorExtraction(payload: CarryPayload, priorYear: number): PriorReturnExtraction {
  const totalCapital = payload.members.reduce((s, m) => s + m.beginning_capital, 0)
  return {
    form_type: "1065",
    tax_year: priorYear,
    ein: null,
    schedule_l: {
      beginning: { cash: 0, total_assets: 0, total_liabilities: 0, capital: 0 },
      ending: { cash: payload.beginning_cash, total_assets: payload.beginning_cash, total_liabilities: 0, capital: totalCapital },
    },
    m2: { beginning_capital: null, ending_capital: totalCapital },
    k1s: payload.members.map(m => ({ partner_name: m.name, ownership_pct: null, ending_capital: m.beginning_capital })),
  }
}

function buildCorrectionRecord(params: {
  kase: "carried_forward" | "staff_corrected"
  source: "our_corrected_books" | "staff_manual_correction"
  note: string
  computedBy: string
  payload: CarryPayload
  priorYear: number
  nowIso: string
}): PriorReturnCaseRecord {
  const { kase, source, note, computedBy, payload, priorYear, nowIso } = params
  return {
    case: kase,
    status: "validated",
    recorded_at: nowIso,
    extracted: toPriorExtraction(payload, priorYear),
    source,
    note,
    beginning_cta: payload.beginning_cta,
    member_links: payload.members.map(m => ({ contact_id: m.contact_id, name: m.name, beginning_capital: m.beginning_capital })),
    unresolved_members: payload.unresolved_members,
    computed_by: computedBy,
    computed_at: nowIso,
  } as PriorReturnCaseRecord
}

/** System-computed carry from our own corrected prior-year books. Callers
 *  (prior-return-correction.ts) are responsible for the trustworthiness check
 *  BEFORE calling this — this function only shapes data, it does not decide
 *  whether the carry is safe to offer. */
export function buildCarriedForwardRecord(payload: CarryPayload, priorYear: number, nowIso: string): PriorReturnCaseRecord {
  return buildCorrectionRecord({
    kase: "carried_forward",
    source: "our_corrected_books",
    note: `Beginning balances carried from our own corrected ${priorYear} books.`,
    computedBy: "system",
    payload, priorYear, nowIso,
  })
}

/** Staff directly enters the true beginning figures — e.g. a filed return is
 *  known to be factually wrong even though it passed extraction validation.
 *  Deliberately has NO canStaffSetPriorReturn-style guard: unlike the staff
 *  first_year/never_filed/clear control (which must never discard a real
 *  extraction), this IS the human override for exactly that case, and may
 *  replace ANY existing case/status (round-3 bug-hunter blocker 1 — the
 *  earlier plan's "mirror the existing guarded route" language was ambiguous
 *  enough to accidentally inherit the guard; this function's contract is
 *  explicit: no guard, ever, by design). Callers (the API route) are
 *  responsible for staff auth and for requiring every CarryPayload field
 *  present in the request — this function trusts what it's given. */
export function buildStaffCorrectionRecord(payload: CarryPayload, priorYear: number, staffEmail: string, nowIso: string): PriorReturnCaseRecord {
  return buildCorrectionRecord({
    kase: "staff_corrected",
    source: "staff_manual_correction",
    note: `Beginning balances entered by staff (${staffEmail}) to correct a prior filing error.`,
    computedBy: staffEmail,
    payload, priorYear, nowIso,
  })
}

export interface ProcessPriorReturnInput {
  submissionId: string
  accountId: string
  /** The CURRENT filing year (the submission's tax_year). */
  taxYear: number
  submittedData: Record<string, unknown>
  uploadPaths: string[]
}

/** Pure resolver for Case C — exported for tests. */
export function firstYearCoherent(formationDate: string | null, taxYear: number): boolean | null {
  if (!formationDate) return null // no formation date on file — cannot cross-check
  const year = new Date(formationDate).getFullYear()
  return Number.isFinite(year) ? year >= taxYear : null
}

export async function processPriorReturnCase(input: ProcessPriorReturnInput): Promise<PriorReturnCaseRecord> {
  const { submissionId, accountId, taxYear, submittedData, uploadPaths } = input
  const priorYear = taxYear - 1
  const now = new Date().toISOString()
  const caseAnswer = String(submittedData.prior_return_case ?? "")

  let record: PriorReturnCaseRecord
  try {
    switch (caseAnswer) {
      case "we_filed": {
        const { onFile, taxReturnId } = await detectPriorReturnOnFile(accountId, priorYear)
        if (!onFile) {
          record = { case: "we_filed", status: "claim_mismatch", tax_return_id: null, note: `Client says we filed the ${priorYear} return, but no 'TR Filed' record exists — staff must verify.`, recorded_at: now }
          break
        }
        // Auto-carry-forward: read OUR filed prior-year return (Schedule L / K-1s)
        // and feed this year's beginning balances. Best-effort — if the PDF
        // isn't found / readable / validated, fall back to staff tie-out
        // (status 'on_file', the original behavior). NEVER throws.
        const { data: acct } = await supabaseAdmin.from("accounts").select("ein_number").eq("id", accountId).single()
        const extracted = await locateAndExtractOurFiledReturn(accountId, priorYear, acct?.ein_number ?? null)
        if (extracted?.status === "validated") {
          record = { case: "we_filed", status: "validated", tax_return_id: taxReturnId, note: `${priorYear} return on file (TR Filed) — beginning balances read from our filed return.`, recorded_at: now, extracted: extracted.extracted, issues: extracted.issues, source: extracted.source }
        } else if (extracted?.status === "quarantined") {
          record = { case: "we_filed", status: "quarantined", tax_return_id: taxReturnId, note: `${priorYear} return on file, but auto-reading it did not pass verification — staff tie out the beginning balances.`, recorded_at: now, extracted: extracted.extracted, issues: extracted.issues, source: extracted.source }
        } else {
          record = { case: "we_filed", status: "on_file", tax_return_id: taxReturnId, note: `${priorYear} return on file (TR Filed) — could not auto-read the filed PDF; staff tie out the beginning balances.`, recorded_at: now }
        }
        break
      }
      case "filed_elsewhere": {
        const path = uploadPaths.find(p => /prior_year_return/i.test(p))
        if (!path) {
          record = { case: "filed_elsewhere", status: "failed", error: "No prior-return upload found on the submission.", recorded_at: now }
          break
        }
        const { data: blob, error: dlErr } = await supabaseAdmin.storage.from(UPLOAD_BUCKET).download(path)
        if (dlErr || !blob) {
          record = { case: "filed_elsewhere", status: "failed", error: `Could not read the uploaded file: ${dlErr?.message ?? "empty"}`, recorded_at: now }
          break
        }
        const { data: acct } = await supabaseAdmin.from("accounts").select("ein_number").eq("id", accountId).single()
        const buffer = Buffer.from(await blob.arrayBuffer())
        const result = await extractPriorReturn(buffer, `upload:${path}`, { priorYear, ein: acct?.ein_number ?? null })
        record = result.status === "failed"
          ? { case: "filed_elsewhere", status: "failed", error: result.error, recorded_at: now }
          : { ...result, case: "filed_elsewhere" }
        break
      }
      case "first_year": {
        const { data: acct } = await supabaseAdmin.from("accounts").select("formation_date").eq("id", accountId).single()
        const coherent = firstYearCoherent(acct?.formation_date ?? null, taxYear)
        record = coherent === false
          ? { case: "first_year", status: "claim_mismatch", formation_date: acct?.formation_date ?? null, note: `Client says ${taxYear} is the first year, but the company was formed ${acct?.formation_date} — staff must verify whether prior returns exist.`, recorded_at: now }
          : { case: "first_year", status: "first_year", formation_date: acct?.formation_date ?? null, note: coherent === null ? "No formation date on file — claim not cross-checked." : "Formation date confirms first year. Beginning balances start at zero.", recorded_at: now }
        break
      }
      case "never_filed": {
        const cleanup = String(submittedData.prior_cleanup_interest ?? "No") === "Yes" ? "Yes" : "No"
        record = {
          case: "never_filed",
          status: "never_filed",
          cleanup_interest: cleanup,
          declaration_accepted: submittedData.prior_never_filed_declaration === true || submittedData.prior_never_filed_declaration === "true",
          recorded_at: now,
        }
        if (cleanup === "Yes") await createBackFilingTask(accountId, priorYear)
        break
      }
      default:
        record = { case: caseAnswer || "missing", status: "failed", error: "No prior-return answer on the submission (pre-matrix submission or skipped field).", recorded_at: now }
    }
  } catch (e) {
    record = { case: caseAnswer, status: "failed", error: e instanceof Error ? e.message : String(e), recorded_at: now }
  }

  // prior_return_extracted is new (migration 20260611-1400) and not yet in
  // database.types.ts — untyped-client pattern until type regeneration.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { error } = await db
    .from("tax_return_submissions")
    .update({ prior_return_extracted: record })
    .eq("id", submissionId)
  if (error) throw new Error(`Failed to store prior-return case record: ${error.message}`)
  return record
}

/** Case D upsell: a staff task to send the back-filing quote. Deduped by title. */
async function createBackFilingTask(accountId: string, priorYear: number): Promise<void> {
  const { data: acct } = await supabaseAdmin.from("accounts").select("company_name").eq("id", accountId).single()
  const taskTitle = `Back-filing quote (${priorYear}) — ${acct?.company_name ?? accountId}`
  const { data: existing } = await supabaseAdmin
    .from("tasks")
    .select("id")
    .eq("account_id", accountId)
    .eq("task_title", taskTitle)
    .neq("status", "Done")
    .limit(1)
    .maybeSingle()
  if (existing) return
  // eslint-disable-next-line no-restricted-syntax -- same legacy plain-task path as the banking wizard task above
  await supabaseAdmin.from("tasks").insert({
    task_title: taskTitle,
    assigned_to: defaultTaskAssignee(),
    status: "To Do",
    priority: "High",
    category: "Filing", // task_category enum has no 'Tax' — verified 2026-06-11
    description: `In the tax wizard the client said no prior-year return was ever filed and asked for a back-filing quote (${priorYear}). Prepare and send the quote.`,
    account_id: accountId,
    created_by: "System",
  })
}
