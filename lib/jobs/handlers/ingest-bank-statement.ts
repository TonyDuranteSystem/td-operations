/**
 * Job Handler: ingest_bank_statement
 *
 * Ingests ONE client-uploaded bank statement (CSV or PDF) into
 * `bank_transactions` for an account+tax_year. Enqueued one-per-file by the
 * tax_form_setup handler (and re-usable anywhere a single statement needs
 * background ingestion).
 *
 * WHY one file per job: a PDF statement read via AI extraction can take ~2 min.
 * A client with a dozen statements would exceed the worker's 300s window if
 * read in a single job — so each file is its own small job. The worker drains
 * them one-by-one; the financials view (/portal/tax-financials) builds the P&L +
 * Balance Sheet on demand once the rows land.
 *
 * Retry semantics: a transient problem (download error, unexpected throw) is
 * THROWN so the worker retries (failJob → pending up to max_attempts). A file
 * the parser simply can't read returns a normal result with an `error` step and
 * `ok: false` — retrying won't fix an unreadable file, so it completes (surfaced
 * in the Exception Center) instead of looping.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import type { Job, JobResult } from "../queue"

interface IngestStatementPayload {
  account_id: string
  tax_year: number
  /** Storage path in the onboarding-uploads bucket. */
  path: string
  /** Fallback bank label; the parser re-detects the real bank from content. */
  bank_label?: string
}

function step(name: string, status: "ok" | "error" | "skipped", detail?: string) {
  return { name, status, detail, timestamp: new Date().toISOString() }
}

export async function handleIngestBankStatement(job: Job): Promise<JobResult> {
  const p = job.payload as unknown as IngestStatementPayload
  const result: JobResult = { steps: [] }

  if (!p.account_id || !Number.isInteger(p.tax_year) || !p.path) {
    result.steps.push(step("validate", "error", "Missing account_id, tax_year, or path"))
    result.ok = false
    result.summary = "Invalid ingest_bank_statement payload"
    return result
  }

  const fileName = p.path.split("/").pop() ?? "statement"

  // Download from storage. A download failure may be transient → THROW so the
  // worker retries it.
  const { data: blob, error: dlErr } = await supabaseAdmin.storage
    .from("onboarding-uploads")
    .download(p.path)
  if (dlErr || !blob) {
    throw new Error(`Download failed for ${fileName}: ${dlErr?.message ?? "no data"}`)
  }
  const buffer = Buffer.from(await blob.arrayBuffer())

  const { ingestPortalCsv } = await import("@/lib/tax/portal-csv-ingest")
  const r = await ingestPortalCsv({
    accountId: p.account_id,
    taxYear: p.tax_year,
    bankLabel: p.bank_label || "Bank",
    accountKind: "checking", // unused by the ingester; kept for the interface
    buffer,
    fileName,
  })

  if (r.ok) {
    result.steps.push(step("ingest", "ok",
      `${fileName}: ${r.inserted} inserted / ${r.parsed} parsed (${r.bankDetected}, ${r.months.join(", ") || "no months"})${r.alert ? ` — ${r.alert}` : ""}`))
    result.summary = `Ingested ${fileName}: ${r.inserted} transactions`
  } else {
    // Unreadable file — do NOT throw (retrying won't help). Surface it.
    result.steps.push(step("ingest", "error", `${fileName}: ${r.error ?? "could not read file"}`))
    result.ok = false
    result.summary = `Could not read ${fileName}`
  }
  return result
}
