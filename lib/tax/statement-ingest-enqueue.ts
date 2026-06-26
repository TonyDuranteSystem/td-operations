/**
 * Idempotent enqueue of `ingest_bank_statement` jobs — one per uploaded bank
 * statement file (CSV / PDF / ZIP).
 *
 * WHY THIS EXISTS (Luca, 2026-06-26): the wizard used to enqueue these jobs
 * ONLY from inside the heavy `tax_form_setup` handler, which runs fire-and-
 * forget after the HTTP response. On a large submission that handler can be
 * killed mid-run before it ever reaches the enqueue step, so the statements
 * are accepted but never read — the P&L stays at $0. The synchronous portal
 * uploader worked precisely because it bypassed that background hop.
 *
 * Fix: enqueue these jobs SYNCHRONOUSLY at wizard-submit time (and keep the
 * tax_form_setup call as a harmless idempotent backstop, since the staff review
 * path also runs that handler). This helper is the single source of truth for
 * BOTH sites, and it is idempotent — it skips any path that already has a
 * non-failed ingest job, so the same (expensive, AI-extracted) PDF is never
 * processed twice.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

const STATEMENT_PATH_RE = /\/(bank_accounts_\d+_statements|bank_statements)_/
const STATEMENT_EXT_RE = /\.(csv|pdf|zip)$/i

/** Match BOTH shapes: per-bank `bank_accounts_<N>_statements_…` and legacy
 *  flat `bank_statements_…`; accept CSV + PDF (+ zip). */
export function filterStatementPaths(uploadPaths: string[]): string[] {
  return uploadPaths.filter(p => STATEMENT_PATH_RE.test(p) && STATEMENT_EXT_RE.test(p))
}

/** Prefer the per-bank bank name the client typed; fall back to the filename
 *  lead token. Fallback label only — the parser detects the real bank from
 *  file CONTENT. */
export function bankLabelForPath(path: string, submittedData: Record<string, unknown>): string {
  const fileName = path.split("/").pop() ?? "statement"
  const idx = path.match(/\/bank_accounts_(\d+)_statements_/)?.[1]
  const typed = idx !== undefined ? String(submittedData[`bank_accounts_${idx}_bank_name`] ?? "").trim() : ""
  const fromName = fileName.replace(/^(bank_accounts_\d+_statements|bank_statements)_[a-z0-9]+_/i, "").split(/[_\-.]/)[0]
  return typed || fromName || "Bank"
}

export interface EnqueueStatementIngestResult {
  /** Newly enqueued ingest jobs. */
  enqueued: number
  /** Statement paths skipped because a non-failed job already exists. */
  skipped: number
}

/**
 * Enqueue one `ingest_bank_statement` job per statement file, skipping any path
 * that already has a pending/processing/completed job (so a re-submit or the
 * backstop call never double-processes a file).
 */
export async function enqueueStatementIngestJobs(params: {
  accountId: string
  taxYear: number
  uploadPaths: string[]
  submittedData: Record<string, unknown>
  createdBy?: string
}): Promise<EnqueueStatementIngestResult> {
  const { accountId, taxYear, uploadPaths, submittedData, createdBy = "portal_wizard" } = params

  const statementPaths = filterStatementPaths(uploadPaths)
  if (statementPaths.length === 0) return { enqueued: 0, skipped: 0 }

  // Idempotency: a path already covered by a non-failed ingest job is skipped.
  // Failed jobs are NOT counted, so a genuinely failed file can be retried by
  // re-uploading it.
  const { data: existing } = await supabaseAdmin
    .from("job_queue")
    .select("payload")
    .eq("account_id", accountId)
    .eq("job_type", "ingest_bank_statement")
    .neq("status", "failed")

  const existingPaths = new Set(
    (existing ?? [])
      .map(r => (r.payload as { path?: string } | null)?.path)
      .filter((p): p is string => typeof p === "string"),
  )

  const toEnqueue = statementPaths.filter(p => !existingPaths.has(p))
  if (toEnqueue.length === 0) {
    return { enqueued: 0, skipped: statementPaths.length }
  }

  // DIRECT insert — NOT enqueueJobs(), which fires triggerWorker() as a dangling
  // fetch that outlives the HTTP response and gets the Vercel function torn down
  // ("No response is returned from route handler" → 500 to the client). This is
  // called from the wizard-submit REQUEST path, so it must leave no dangling
  // promise. The 5-min process-jobs cron drains these ingest rows. (2026-06-26)
  await supabaseAdmin.from("job_queue").insert(
    toEnqueue.map(path => ({
      job_type: "ingest_bank_statement",
      payload: { account_id: accountId, tax_year: taxYear, path, bank_label: bankLabelForPath(path, submittedData) },
      priority: 4,
      account_id: accountId,
      created_by: createdBy,
    })) as never,
  )

  return { enqueued: toEnqueue.length, skipped: statementPaths.length - toEnqueue.length }
}
