/**
 * Idempotent enqueue of the durable `archive_tax_submission` job.
 *
 * Single source of truth for BOTH enqueue sites (wizard-submit synchronous +
 * the tax_form_setup backstop) and the sweep. Idempotent on TWO axes so a
 * re-submit, the backstop, and the sweep can never pile up duplicate archive
 * jobs or race two writers into the same Drive folder:
 *   1. Already archived (drive_archived_at set) → nothing to do.
 *   2. A non-failed archive job already exists for this submission → skip.
 * A FAILED job is not counted, so a genuinely-failed submission is retryable.
 *
 * DIRECT insert (not enqueueJobs) — this is called from the wizard-submit
 * REQUEST path, so it must leave no dangling triggerWorker() promise that
 * outlives the HTTP response. The 5-min process-jobs cron drains it.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export interface EnqueueArchiveResult {
  status: "enqueued" | "already_archived" | "already_queued" | "no_submission"
}

export async function enqueueTaxArchiveJob(params: {
  submissionId: string
  accountId?: string | null
  createdBy?: string
}): Promise<EnqueueArchiveResult> {
  const { submissionId, createdBy = "tax_archive" } = params

  const { data: sub } = await supabaseAdmin
    .from("tax_return_submissions")
    .select("id, account_id, drive_archived_at")
    .eq("id", submissionId)
    .maybeSingle()
  if (!sub) return { status: "no_submission" }
  if ((sub as { drive_archived_at?: string | null }).drive_archived_at) return { status: "already_archived" }

  const accountId = params.accountId ?? (sub as { account_id?: string | null }).account_id ?? null

  // Idempotency: skip if a non-failed archive job for this submission exists.
  const { data: existing } = await supabaseAdmin
    .from("job_queue")
    .select("id, payload")
    .eq("job_type", "archive_tax_submission")
    .neq("status", "failed")

  const already = (existing ?? []).some(
    r => (r.payload as { submission_id?: string } | null)?.submission_id === submissionId,
  )
  if (already) return { status: "already_queued" }

  await supabaseAdmin.from("job_queue").insert({
    job_type: "archive_tax_submission",
    payload: { submission_id: submissionId, account_id: accountId },
    priority: 5,
    account_id: accountId,
    created_by: createdBy,
    related_entity_type: "tax_return_submission",
    related_entity_id: submissionId,
  } as never)

  return { status: "enqueued" }
}
