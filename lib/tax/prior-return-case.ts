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
import { detectPriorReturnOnFile, extractPriorReturn, type PriorReturnRecord } from "./prior-return-extract"

const UPLOAD_BUCKET = "onboarding-uploads" // same bucket as all portal wizard uploads

/** Discriminated union stored in tax_return_submissions.prior_return_extracted. */
export type PriorReturnCaseRecord =
  | (PriorReturnRecord & { case: "filed_elsewhere" })
  | { case: "we_filed"; status: "on_file" | "claim_mismatch"; tax_return_id: string | null; note: string; recorded_at: string }
  | { case: "first_year"; status: "first_year" | "claim_mismatch"; formation_date: string | null; note: string; recorded_at: string }
  | { case: "never_filed"; status: "never_filed"; cleanup_interest: "Yes" | "No"; declaration_accepted: boolean; recorded_at: string }
  | { case: string; status: "failed"; error: string; recorded_at: string }

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
        record = onFile
          ? { case: "we_filed", status: "on_file", tax_return_id: taxReturnId, note: `${priorYear} return on file (TR Filed).`, recorded_at: now }
          : { case: "we_filed", status: "claim_mismatch", tax_return_id: null, note: `Client says we filed the ${priorYear} return, but no 'TR Filed' record exists — staff must verify.`, recorded_at: now }
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
