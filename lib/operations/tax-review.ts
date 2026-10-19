/**
 * Tax review operations — single source of truth for "approve and apply
 * a completed tax_return_submissions row".
 *
 * Shared by:
 *   - `tax_form_review(apply_changes=true)` MCP tool
 *   - `tax.approve_and_apply` workflow handler
 *
 * Both code paths call `approveAndApplyTaxReview` so the apply logic lives
 * in one place and the `reviewed_at` short-circuit protects against B9
 * (double-execution when admin uses both surfaces on the same submission).
 *
 * The auto-chain (/api/tax-form-completed) ALREADY does:
 *   - Update contact (changed fields only)
 *   - Passport check for one-time customers
 *   - Email notification to support@
 *   - Update tax_returns.status → "Data Received"
 *   - Advance Tax Return SD → "Data Received"
 *   - Save form data + uploads to Drive
 *   - Auto-parse bank statements (MMLLC/Corp) + generate P&L
 *
 * The work this helper does on apply:
 *   - Enqueue `tax_form_setup` background job (does the post-form CRM
 *     reconciliation: contact + account + tax_returns + form review flag)
 *   - Mark submission as reviewed (reviewed_at, reviewed_by)
 *
 * The background job has its own retry/idempotency machinery, so enqueueing
 * twice is benign (the job key includes submission_id). The `reviewed_at`
 * short-circuit here prevents the redundant enqueue.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { enqueueJob } from "@/lib/jobs/queue"

export interface ApproveTaxReviewParams {
  submission_id: string
  /** Actor identifier for the reviewed_by audit column. Examples: 'claude', 'workflow:tax.approve_and_apply', a user UUID. */
  actor: string
  /**
   * Apply the client's corrections (job enqueued, Data Received set) but leave the submission UNREVIEWED — for a form that could
   * not be filed anywhere. The job skips its own "Form → reviewed" step and this helper does not stamp reviewed_at, so running
   * the review again after the form is filed still works.
   */
  leaveUnreviewed?: boolean
}

export interface ApproveTaxReviewResult {
  ok: boolean
  /** True if the submission was already reviewed_at IS NOT NULL on entry. */
  alreadyApplied?: boolean
  /** Job ID enqueued for the tax_form_setup background processor. */
  job_id?: string
  /** True when the corrections had ALREADY been applied by an earlier review run: nothing was enqueued again. */
  correctionsAlreadyApplied?: boolean
  /** Account associated with the submission. */
  account_id?: string | null
  /** Company name (resolved from accounts.company_name; falls back to token). */
  company_name?: string
  /** Echo of submission's tax_year for caller convenience. */
  tax_year?: number
  error?: string
}

/**
 * Apply a completed tax submission. Idempotent via reviewed_at short-circuit.
 *
 * Returns alreadyApplied=true if the row was already reviewed — caller
 * should NOT re-enqueue and should NOT treat this as failure.
 */
export async function approveAndApplyTaxReview(
  params: ApproveTaxReviewParams,
): Promise<ApproveTaxReviewResult> {
  const { submission_id, actor, leaveUnreviewed } = params

  // ── 1. Load submission + early short-circuit on reviewed_at ──────────
  const { data: sub, error: subErr } = await supabaseAdmin
    .from("tax_return_submissions")
    .select(
      "id, token, account_id, contact_id, tax_year, tax_return_id, changed_fields, reviewed_at, status",
    )
    .eq("id", submission_id)
    .maybeSingle()
  if (subErr) {
    return { ok: false, error: `tax_return_submissions lookup failed: ${subErr.message}` }
  }
  if (!sub) {
    return { ok: false, error: `tax_return_submissions row not found for id ${submission_id}` }
  }
  if (sub.status !== "completed" && sub.status !== "reviewed") {
    return { ok: false, error: `Submission is not completed (status='${sub.status}') — cannot apply` }
  }

  let companyName = sub.token
  if (sub.account_id) {
    const { data: acct } = await supabaseAdmin
      .from("accounts")
      .select("company_name")
      .eq("id", sub.account_id)
      .maybeSingle()
    if (acct?.company_name) companyName = acct.company_name
  }

  if (sub.reviewed_at) {
    return {
      ok: true,
      alreadyApplied: true,
      account_id: sub.account_id,
      company_name: companyName,
      tax_year: sub.tax_year,
    }
  }

  // ── 2. Apply the corrections ONCE ──────────────────────────────────
  // The tax_form_setup job does the heavy lifting (contact + account update, tax_returns lifecycle, SD advance, the support
  // email). It must run ONCE per review: a second review run (e.g. after a filing problem was fixed) must only retry what is
  // left — never reset the tax return, re-advance the case, re-send the email or overwrite staff edits. The durable record that
  // it was applied is the job itself: a non-failed review job for this submission already in the queue.
  let jobId: string | undefined
  let correctionsAlreadyApplied = false
  try {
    const existing = await findReviewApplyJob(sub.id)
    if (existing) {
      jobId = existing
      correctionsAlreadyApplied = true
    } else {
      try {
      const enq = await enqueueJob({
        job_type: "tax_form_setup",
        payload: {
          token: sub.token,
          submission_id: sub.id,
          contact_id: sub.contact_id || null,
          account_id: sub.account_id || null,
          tax_return_id: sub.tax_return_id || null,
          changed_fields: sub.changed_fields,
          review_apply: true,
          ...(leaveUnreviewed ? { leave_unreviewed: true } : {}),
        },
        priority: 1,
        max_attempts: 3,
        account_id: sub.account_id || undefined,
        related_entity_type: "tax_return_submission",
        related_entity_id: sub.id,
        created_by: actor,
      })
      jobId = enq.id
      } catch (e) {
        // Two near-simultaneous reviews: the database allows ONE review-apply job per submission (unique index
        // uq_job_queue_tax_review_apply), so the loser's insert fails — that means "already applied", not an error.
        if (!isDuplicateJobError(e)) throw e
        const winner = await findReviewApplyJob(sub.id)
        if (!winner) throw e
        jobId = winner
        correctionsAlreadyApplied = true
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: `Failed to enqueue tax_form_setup job: ${err instanceof Error ? err.message : String(err)}`,
      account_id: sub.account_id,
      company_name: companyName,
      tax_year: sub.tax_year,
    }
  }

  if (leaveUnreviewed) {
    return { ok: true, job_id: jobId, correctionsAlreadyApplied, account_id: sub.account_id, company_name: companyName, tax_year: sub.tax_year }
  }

  // ── 3. Mark submission as reviewed (idempotency anchor) ─────────────
  const { error: markErr } = await supabaseAdmin
    .from("tax_return_submissions")
    .update({
      status: "reviewed",
      reviewed_at: new Date().toISOString(),
      reviewed_by: actor,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sub.id)
    .is("reviewed_at", null)
  if (markErr) {
    return {
      ok: false,
      error: `Failed to mark submission reviewed: ${markErr.message}`,
      job_id: jobId,
      account_id: sub.account_id,
      company_name: companyName,
      tax_year: sub.tax_year,
    }
  }

  return {
    ok: true,
    job_id: jobId,
    correctionsAlreadyApplied,
    account_id: sub.account_id,
    company_name: companyName,
    tax_year: sub.tax_year,
  }
}

/**
 * The id of a non-failed review job (tax_form_setup with review_apply) already queued for this submission, or null.
 * A failed / cancelled job does NOT count (the corrections were not applied, so the next run enqueues again). A lookup error
 * throws — a duplicate apply is the dangerous direction, so an unreadable queue is never read as "nothing queued".
 */
/** Is this the unique-index refusal of a second review-apply job? */
export function isDuplicateJobError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /duplicate key|uq_job_queue_tax_review_apply|23505/i.test(msg)
}

export async function findReviewApplyJob(submissionId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("job_queue")
    .select("id")
    .eq("job_type", "tax_form_setup")
    .eq("related_entity_type", "tax_return_submission")
    .eq("related_entity_id", submissionId)
    .eq("payload->>review_apply", "true")
    .in("status", ["pending", "processing", "completed"])
    .order("created_at", { ascending: true })
    .limit(1)
  if (error) throw new Error(`could not check whether the corrections were already applied: ${error.message}`)
  return ((data ?? [])[0]?.id as string | undefined) ?? null
}
