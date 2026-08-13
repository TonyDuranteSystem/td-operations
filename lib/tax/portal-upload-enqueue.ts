/**
 * Portal tax-financials upload — SAVE + ENQUEUE (async ingestion).
 *
 * WHY THIS EXISTS (prod bug, 2026-06-26): the portal uploader used to run the
 * full ingestion (parse → categorize → per-row insert loop → full-year
 * recategorization) SYNCHRONOUSLY inside the HTTP request. On production that
 * work outlived/overran the request and Vercel tore the function down before it
 * could respond — the client saw "No response is returned from route handler"
 * (empty 500) even though the rows had been ingested. Two promise-targeted
 * fixes did NOT help precisely because the cause is the heavy synchronous work
 * itself, not a dangling promise.
 *
 * Fix: the uploader now mirrors the proven wizard path — it only ARCHIVES the
 * raw file to storage and enqueues ONE `ingest_bank_statement` job. The
 * existing background worker (kicked promptly, drained by the 5-min cron as a
 * safety net) runs `ingestPortalCsv` from the stored file. The financials view
 * already surfaces in-flight ingestion (`ingestPending`) and the client already
 * polls every 20s, so the transactions + P&L fill in as the job completes.
 *
 * This helper is the single testable unit for that save+enqueue step. The route
 * stays a thin wrapper (auth, validate, then call this) so nothing heavy runs in
 * the request.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { sha256Hex } from "./statement-uploads"

export interface SaveAndEnqueueInput {
  accountId: string
  taxYear: number
  /** Client's free-text bank name — fallback identity only; parser re-detects. */
  bankLabel: string
  /** Client-provided account number/label for this file (account identity). */
  accountNumber?: string | null
  buffer: Buffer
  fileName: string
}

export interface SaveAndEnqueueResult {
  /** A new ingest job was enqueued. */
  queued: boolean
  /** This exact file already had a non-failed ingest job — skipped (idempotent). */
  alreadyQueued: boolean
  /** Storage path the file was archived to (and the job reads from). */
  path: string
}

/**
 * Archive the raw statement file to `onboarding-uploads` and enqueue one
 * `ingest_bank_statement` job for it. Idempotent: the same file content maps to
 * the same content-hashed path, and a path that already has a non-failed ingest
 * job is not re-enqueued (so a double-click or retry never double-processes).
 *
 * Does NO parsing/ingestion — that runs in the background job. Keeps the request
 * light so it can never overrun the serverless function (the prod-500 fix).
 */
export async function saveAndEnqueueStatementUpload(
  input: SaveAndEnqueueInput,
): Promise<SaveAndEnqueueResult> {
  const { accountId, taxYear, bankLabel, accountNumber, buffer, fileName } = input

  const sha = sha256Hex(buffer)
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_")
  // Content-hashed + year-namespaced path: re-uploading the identical file lands
  // on the same object (upsert) instead of piling up duplicate archives.
  const path = `tax/${accountId}/${taxYear}/${sha.slice(0, 16)}_${safeName}`

  const contentType = /\.pdf$/i.test(fileName)
    ? "application/pdf"
    : /\.zip$/i.test(fileName)
      ? "application/zip"
      : "text/csv"

  // 1. Archive the raw file (small, fast — the only storage write in-request).
  const { error: upErr } = await supabaseAdmin.storage
    .from("onboarding-uploads")
    .upload(path, buffer, { contentType, upsert: true })
  if (upErr) {
    throw new Error(`Could not save your file: ${upErr.message}`)
  }

  // 2. Idempotency: skip if this exact path already has a LIVE ingest job.
  //    Failed jobs don't count (a failed file retries by re-upload) and
  //    CANCELLED jobs don't count either — delete-supersede flips a deleted
  //    file's jobs to 'cancelled' precisely so the identical re-upload
  //    re-ingests (card 4a39e0fd; the first cut used .neq('failed') and the
  //    cancelled row still blocked the re-add — bug-hunter blocker, the
  //    "vanished statement" bug survived its own fix).
  const { data: existing } = await supabaseAdmin
    .from("job_queue")
    .select("id")
    .eq("job_type", "ingest_bank_statement")
    .eq("account_id", accountId)
    .eq("payload->>path", path)
    .in("status", ["pending", "processing", "completed"])
    .limit(1)
  if (existing && existing.length > 0) {
    return { queued: false, alreadyQueued: true, path }
  }

  // 3. DIRECT insert — NOT enqueueJobs(), whose triggerWorker() fetch dangles
  //    past the HTTP response and tears the function down (the very class of bug
  //    this rewrite removes). The route awaits a bounded worker kick separately;
  //    the 5-min process-jobs cron is the safety-net drainer.
  const { error: jobErr } = await supabaseAdmin.from("job_queue").insert({
    job_type: "ingest_bank_statement",
    payload: { account_id: accountId, tax_year: taxYear, path, bank_label: bankLabel, account_number: accountNumber ?? null },
    priority: 4,
    account_id: accountId,
    created_by: "portal_tax_upload",
  } as never)
  if (jobErr) {
    throw new Error(`Could not queue your file for processing: ${jobErr.message}`)
  }

  return { queued: true, alreadyQueued: false, path }
}
