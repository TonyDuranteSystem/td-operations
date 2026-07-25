/**
 * Idempotent enqueue of the durable `archive_submission` job (generic engine).
 *
 * Single source of truth for every enqueue site of the non-tax forms (each form's
 * completion route + MCP tool + wizard path) and the backstop sweep. Idempotent on
 * two axes so a re-submit, the backstop, and the sweep can never pile up duplicate
 * archive jobs or race two writers into the same Drive folder:
 *   1. Already archived (drive_archived_at set) → nothing to do.
 *   2. A non-failed archive_submission job for this submission already exists → skip.
 * A FAILED job is not counted, so a genuinely-failed submission stays retryable.
 *
 * PIN AT SUBMISSION: the fire path (which knows its own origin) passes `pin` — the
 * resolved folder id, bucket, config key and upload paths — and we stamp it into
 * drive_archive_meta.pinned_plan. The durable job then archives from the pinned
 * plan instead of re-deriving a folder from a mutable name or re-guessing the
 * bucket (the two-copies-in-two-folders hazard). Banking especially needs this:
 * the portal-wizard update does not persist upload_paths on the row.
 *
 * DIRECT insert (not enqueueJobs) — callable from a request path, so it must leave
 * no dangling triggerWorker() promise outliving the HTTP response. The 5-min
 * process-jobs cron drains it.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { getArchiveRecipe, type ArchivePlan } from "@/lib/forms/archive-registry"

export interface EnqueueFormArchiveResult {
  status: "enqueued" | "already_archived" | "already_queued" | "no_submission" | "no_recipe"
}

export async function enqueueFormArchiveJob(params: {
  formType: string
  submissionId: string
  pin?: ArchivePlan
  createdBy?: string
}): Promise<EnqueueFormArchiveResult> {
  const { formType, submissionId, pin, createdBy = "forms_archive" } = params
  const recipe = getArchiveRecipe(formType)
  if (!recipe) return { status: "no_recipe" }

  // Cast: recipe.table is a runtime string; the typed client needs a table
  // literal (every recipe.table IS a real submission table).
  const tbl = recipe.table as "banking_submissions"
  const { data: sub } = await supabaseAdmin
    .from(tbl)
    .select("id, account_id, drive_archived_at, drive_archive_meta")
    .eq("id", submissionId)
    .maybeSingle()
  if (!sub) return { status: "no_submission" }
  const s = sub as { account_id?: string | null; drive_archived_at?: string | null; drive_archive_meta?: Record<string, unknown> | null }

  // The fire path (pin present) is an AUTHORITATIVE (re)submission: a resubmit
  // carries NEW/corrected files, so we must re-archive even if the row was
  // archived before. Clear the marker + pin the fresh plan so the durable job
  // re-runs. Only the NO-PIN backstop/sweep path honours already-archived (it
  // must never re-touch a settled row). (bug-hunter major #3, 2026-07-24.)
  if (!pin && s.drive_archived_at) return { status: "already_archived" }

  if (pin) {
    // Check the returned error (supabase-js returns { error }, does not throw) —
    // a swallowed pin-write is what let a wizard row later fall back to an empty
    // package (bug-hunter major #2). The fallback is now safe (resolvePlan unions
    // submitted_data), but a failed pin still deserves a loud log.
    const { error: pinErr } = await supabaseAdmin
      .from(tbl)
      .update({
        drive_archived_at: null,
        drive_archive_meta: { ...(s.drive_archive_meta ?? {}), pinned_plan: pin },
      } as never)
      .eq("id", submissionId)
    if (pinErr) console.error(`[forms/archive-enqueue] pin write failed for ${formType} ${submissionId} (job will fall back to resolvePlan):`, pinErr.message)
  }

  // Idempotency: skip only if an IN-FLIGHT (pending/processing) archive job for
  // this submission already exists. A COMPLETED job must NOT block a resubmit's
  // fresh archival (that was bug-hunter #3's other half); a FAILED job stays
  // retryable. This also collapses the external-route + MCP-review double-fire.
  const { data: existing } = await supabaseAdmin
    .from("job_queue")
    .select("id, payload")
    .eq("job_type", "archive_submission")
    .in("status", ["pending", "processing"])

  const already = (existing ?? []).some(
    r => (r.payload as { submission_id?: string } | null)?.submission_id === submissionId,
  )
  if (already) return { status: "already_queued" }

  const accountId = s.account_id ?? null
  const { error: insErr } = await supabaseAdmin.from("job_queue").insert({
    job_type: "archive_submission",
    payload: { form_type: formType, table: recipe.table, submission_id: submissionId },
    priority: 5,
    account_id: accountId,
    created_by: createdBy,
    related_entity_type: recipe.table,
    related_entity_id: submissionId,
  } as never)
  if (insErr) {
    console.error(`[forms/archive-enqueue] job insert failed for ${formType} ${submissionId}:`, insErr.message)
    throw new Error(`archive enqueue: job insert failed: ${insErr.message}`)
  }

  return { status: "enqueued" }
}
