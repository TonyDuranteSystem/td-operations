/**
 * Durable job handler: archive ONE tax submission's package to Google Drive.
 *
 * Thin wrapper around archiveTaxSubmission — all the reliability logic (folder
 * resolution, per-file bucket, full-success marker, retry-on-partial) lives
 * there. This handler exists so the work runs on job_queue and inherits its
 * retry + backoff: a throw here (transient read, timeout, partial copy) resets
 * the row to pending for another attempt; after max_attempts the row stays
 * `failed` and the backstop sweep (which keys on drive_archived_at IS NULL)
 * raises the ONE loud staff alert. Re-running only re-does Drive work — it never
 * re-sends the client emails / re-advances the SD (that's why this is split out
 * of tax_form_setup, mirroring ingest_bank_statement).
 */

import type { Job, JobResult } from "../queue"
import { archiveTaxSubmission } from "@/lib/tax/archive-submission"

export async function handleArchiveTaxSubmission(job: Job): Promise<JobResult> {
  const now = () => new Date().toISOString()
  const submissionId = (job.payload as { submission_id?: string } | null)?.submission_id
  if (!submissionId) {
    return { steps: [{ name: "archive", status: "error", detail: "payload.submission_id missing", timestamp: now() }], ok: false }
  }

  // Throws on any unrecovered failure → job_queue retries; the sweep alerts if
  // it ultimately can't archive. A clean success (or already-archived no-op)
  // returns ok.
  const result = await archiveTaxSubmission(submissionId)
  return {
    steps: [{
      name: "archive",
      status: "ok",
      detail:
        result.status === "archived"
          ? `Archived (${result.copied ?? 0} copied, ${result.skipped ?? 0} already present)`
          : result.status,
      timestamp: now(),
    }],
  }
}
