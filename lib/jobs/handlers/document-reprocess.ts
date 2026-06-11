/**
 * document_reprocess job — re-run OCR + classification for a document whose
 * first processing attempt failed (e.g. Document AI outage, transient Drive
 * error). Queued by the process-and-share route when staff share a file that
 * has status='error': the share goes through immediately (honest error status
 * kept), and this job heals classification in the background once the OCR
 * backend recovers.
 *
 * Queue semantics give us the retry loop for free: throwing makes the cron
 * call failJob(), which re-queues until max_attempts (the enqueuer sets 12 ≈
 * one hour of 5-min cron retries); outages longer than that surface in the
 * daily audit-health-check OCR check.
 *
 * No client alerting here — visibility was already granted at share time and
 * the alert module's client_notified_at guard prevents any re-notify. Note
 * processFile() preserves portal_visible (field omitted from its upsert),
 * with one deliberate exception: a doc that classifies as personal
 * (category 2) without a resolvable owner is force-hidden — that is the
 * standing privacy rule, not a regression.
 */

import { processFile } from "@/lib/mcp/tools/doc"
import type { Job, JobResult } from "@/lib/jobs/queue"

interface DocumentReprocessPayload {
  document_id?: string
  drive_file_id?: string
  account_id?: string
}

export async function handleDocumentReprocess(job: Job): Promise<JobResult> {
  const payload = (job.payload ?? {}) as DocumentReprocessPayload
  const { drive_file_id, account_id, document_id } = payload

  if (!drive_file_id) {
    // Malformed payload (should never happen — enqueued by our own route).
    // ok:false routes it to the Exception Center's Failed Jobs section.
    return {
      ok: false,
      summary: "document_reprocess: payload.drive_file_id is required",
      steps: [step("validate_payload", "error", "missing drive_file_id")],
    }
  }

  // account_id is passed through so processFile's upsert re-links the account
  // (its upsert writes account_id from the argument — omitting it would null
  // the link on a previously linked document).
  const result = await processFile(drive_file_id, account_id || undefined)

  if (!result.success) {
    // Throw → cron failJob() → re-queued until max_attempts (OCR may still
    // be down; that is exactly the case this job exists to wait out).
    throw new Error(`reprocess failed for document ${document_id ?? drive_file_id}: ${result.error ?? "unknown error"}`)
  }

  return {
    summary: `Reprocessed ${result.fileName}: ${result.type ?? "unclassified"} (${result.status})`,
    steps: [step("process_file", "ok", `${result.fileName} → ${result.status}`)],
  }
}

function step(name: string, status: "ok" | "error" | "skipped", detail?: string) {
  return { name, status, detail, timestamp: new Date().toISOString() }
}
