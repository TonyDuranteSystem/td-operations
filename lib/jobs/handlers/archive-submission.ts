/**
 * Durable job handler: archive ONE non-tax form submission's package to Google
 * Drive (generic engine). Thin wrapper around archiveFormSubmission — all the
 * reliability logic (pinned-plan / folder resolution, per-file bucket, full-
 * success marker, retry-on-partial, meta merge) lives there.
 *
 * Runs on job_queue so it inherits retry + backoff: a throw here (transient read,
 * timeout, partial copy) resets the row to pending for another attempt; after
 * max_attempts the row stays `failed` and the backstop sweep (keyed on
 * drive_archived_at IS NULL) raises the ONE loud staff alert. Re-running only
 * re-does Drive work — it never re-sends emails / re-advances the SD (that's why
 * archival is split into its own job, mirroring archive_tax_submission).
 */

import type { Job, JobResult } from "../queue"
import { archiveFormSubmission } from "@/lib/forms/archive-submission"

export async function handleArchiveSubmission(job: Job): Promise<JobResult> {
  const now = () => new Date().toISOString()
  const payload = job.payload as { form_type?: string; submission_id?: string } | null
  const formType = payload?.form_type
  const submissionId = payload?.submission_id
  if (!formType || !submissionId) {
    return {
      steps: [{ name: "archive", status: "error", detail: "payload.form_type / submission_id missing", timestamp: now() }],
      ok: false,
    }
  }

  const result = await archiveFormSubmission(formType, submissionId)
  return {
    steps: [{
      name: "archive",
      status: "ok",
      detail:
        result.status === "archived"
          ? `Archived ${formType} (${result.copied ?? 0} copied, ${result.skipped ?? 0} already present)`
          : `${formType}: ${result.status}`,
      timestamp: now(),
    }],
  }
}
