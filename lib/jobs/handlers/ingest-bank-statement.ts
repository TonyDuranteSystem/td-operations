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

  // A .zip is a YEAR of monthly statements. Reading them all in this one job
  // exceeds the worker's time budget on a big archive (e.g. a 1.5 MB Mercury
  // zip of 12 statements) → the job is reaped, retried, and eventually fails.
  // Instead, EXPAND the zip here (cheap: unzip + save, no AI) and enqueue ONE
  // ingest_bank_statement job per inner statement, so each piece is small
  // enough to finish. The per-file jobs go through the SAME handler (their
  // paths are .pdf/.csv, so this branch is skipped for them).
  if (p.path.toLowerCase().endsWith(".zip")) {
    const { extractZipStatements } = await import("@/lib/bank-statement-parser")
    const { saveAndEnqueueStatementUpload } = await import("@/lib/tax/portal-upload-enqueue")
    let inner: Awaited<ReturnType<typeof extractZipStatements>>
    try {
      inner = await extractZipStatements(buffer)
    } catch (e) {
      // A corrupt archive won't fix itself on retry — surface it, don't throw.
      result.steps.push(step("expand_zip", "error", `${fileName}: could not open archive — ${e instanceof Error ? e.message : String(e)}`))
      result.ok = false
      result.summary = `Could not open ${fileName}`
      return result
    }
    if (inner.length === 0) {
      result.steps.push(step("expand_zip", "error", `${fileName}: no PDF/CSV statements found inside the archive`))
      result.ok = false
      result.summary = `No statements found in ${fileName}`
      return result
    }
    let enqueued = 0, skipped = 0
    const failures: string[] = []
    for (const entry of inner) {
      try {
        const r = await saveAndEnqueueStatementUpload({
          accountId: p.account_id,
          taxYear: p.tax_year,
          bankLabel: p.bank_label || "Bank",
          buffer: Buffer.from(entry.bytes),
          fileName: entry.name,
        })
        if (r.queued) enqueued++
        else if (r.alreadyQueued) skipped++
      } catch (e) {
        failures.push(`${entry.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    // A genuine save/enqueue failure IS transient (storage/db) → throw so the
    // worker retries the whole expansion (idempotent: already-queued inner files
    // are skipped on the retry).
    if (enqueued === 0 && skipped === 0 && failures.length > 0) {
      throw new Error(`Failed to expand ${fileName}: ${failures.join("; ")}`)
    }
    result.steps.push(step("expand_zip", "ok",
      `${fileName}: expanded into ${inner.length} statement(s) — ${enqueued} queued, ${skipped} already queued${failures.length ? `, ${failures.length} failed: ${failures.join("; ")}` : ""}`))
    result.summary = `Expanded ${fileName} into ${enqueued + skipped} statement job(s)`
    return result
  }

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
      `${fileName}: ${r.inserted} inserted / ${r.parsed} parsed (${r.bankDetected}, ${r.months.join(", ") || "no months"})${r.failed ? ` — ⚠ ${r.failed} row(s) FAILED to insert (error-audited)` : ""}${r.alert ? ` — ${r.alert}` : ""}`))
    result.summary = `Ingested ${fileName}: ${r.inserted} transactions`
    // S2 slice 3: persist the AI-extraction reconciliation verdict on the job
    // result so receipts/staff can see "read but unverified" PDFs.
    ;(result as unknown as Record<string, unknown>).reconciliation = r.reconciliation ?? null

    // If this was the LAST statement for the account+year, tell the client their
    // P&L is ready (one-time, locale-aware). Self-gates + never throws, so it
    // can never break the ingest job. selfJobId is excluded from the in-flight
    // count (this job is still 'processing' while its handler runs).
    const { notifyIfIngestComplete } = await import("../ingest-complete-notify")
    const notif = await notifyIfIngestComplete({ accountId: p.account_id, taxYear: p.tax_year, selfJobId: job.id })
    if (notif.notified) result.steps.push(step("notify_ready", "ok", "client notified: statements ready"))
  } else {
    // Unreadable file — do NOT throw (retrying won't help). Surface it.
    result.steps.push(step("ingest", "error", `${fileName}: ${r.error ?? "could not read file"}`))
    result.ok = false
    result.summary = `Could not read ${fileName}`
  }
  return result
}
