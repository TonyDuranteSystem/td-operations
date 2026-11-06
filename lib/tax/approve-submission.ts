/**
 * Staff APPROVE a tax submission — and release it (Tax Return plan, Part 2, 2026-11-06).
 *
 * The client's own "Confirm" step is gone (Antonio, 2026-11-06: not one client ever pressed it). Approving now does what the client's
 * Confirm used to do: the submission is released (`review_status` → `confirmed`, the client's data locks), the tax record becomes
 * "Data Received" and the job moves on to "Data Received" (`applyConfirmedTaxSubmission`). Two doors lead here and both call this:
 *   - the What's New / Calendar card button  (POST /api/crm/tax-review/action, action "approve"), by submission id;
 *   - the workspace "Approve" button          (POST /api/flows/[id]/advance, target "Data Received"), by service delivery id.
 *
 * Design notes:
 *  - Idempotent: a second press on a released submission is a no-op (`already_released`).
 *  - TOCTOU-guarded: the UPDATE pins the prior review_status, so a concurrent writer (a client resubmit, the other door) is never clobbered.
 *  - Writes `confirmed` directly with ONE history round whose actor is staff — no half-state (`approved`) is ever persisted.
 *  - No message goes to the client: the old flow asked them to press Confirm; the banner now simply reads "Being prepared".
 *  - Best-effort by contract for the workspace door: the caller treats anything but `approved` / `already_released` / `no_submission` as
 *    a visible warning and never undoes the stage move the staff member already saw succeed.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { buildReviewHistoryEntry, canStaffApprove, type ReviewStatus } from "@/lib/tax/review-status"
import { pickTargetSubmission } from "@/lib/tax/pick-target-submission"
import { applyConfirmedTaxSubmission, type ApplyStep } from "@/lib/tax/apply-confirmed-submission"
import { TAX_WIZARD_SERVICE_TYPES } from "@/lib/tax/wizard-eligibility"

export interface ApproveTaxSubmissionResult {
  status:
    | "approved" // released now
    | "already_released" // was already confirmed — nothing to do
    | "no_submission" // the job has no submission (e.g. data uploaded by staff) — nothing to release
    | "not_in_review" // the submission never entered the review loop (an older external-form submission) — nothing to release
    | "not_approvable" // the client is still editing it (changes requested / reopened)
    | "not_tax_flow"
    | "no_account"
    | "conflict" // a concurrent writer moved the row first
    | "error"
  submissionId?: string
  from?: ReviewStatus | null
  apply?: ApplyStep[]
  detail?: string
}

export type ApproveTarget = { submissionId: string } | { serviceDeliveryId: string }

export async function approveTaxSubmission(params: ApproveTarget & { by: string }): Promise<ApproveTaxSubmissionResult> {
  type Sub = {
    id: string
    account_id: string | null
    tax_year: number | null
    review_status: string | null
    review_history: unknown
    created_at: string
  }
  let sub: Sub | null = null

  if ("submissionId" in params) {
    const { data, error } = await supabaseAdmin
      .from("tax_return_submissions")
      .select("id, account_id, tax_year, review_status, review_history, created_at")
      .eq("id", params.submissionId)
      .maybeSingle()
    if (error) return { status: "error", detail: error.message }
    if (!data) return { status: "no_submission" }
    sub = data as Sub
  } else {
    const { data: sd, error: sdErr } = await supabaseAdmin
      .from("service_deliveries")
      .select("service_type, account_id")
      .eq("id", params.serviceDeliveryId)
      .maybeSingle()
    if (sdErr) return { status: "error", detail: sdErr.message }
    if (!sd) return { status: "error", detail: "service delivery not found" }
    if (!TAX_WIZARD_SERVICE_TYPES.includes(sd.service_type)) return { status: "not_tax_flow" }
    if (!sd.account_id) return { status: "no_account" }

    const [subsRes, openRes] = await Promise.all([
      supabaseAdmin
        .from("tax_return_submissions")
        .select("id, account_id, tax_year, review_status, review_history, created_at")
        .eq("account_id", sd.account_id),
      supabaseAdmin.from("tax_returns").select("tax_year").eq("account_id", sd.account_id).eq("data_received", false),
    ])
    if (subsRes.error) return { status: "error", detail: subsRes.error.message }
    if (openRes.error) return { status: "error", detail: openRes.error.message }
    sub = pickTargetSubmission((subsRes.data ?? []) as Sub[], (openRes.data ?? []).map((r) => r.tax_year as number))
    if (!sub) return { status: "no_submission" }
  }

  const current = (sub.review_status ?? null) as ReviewStatus | null
  if (current === "confirmed") return { status: "already_released", submissionId: sub.id, from: current }
  if (current === null) return { status: "not_in_review", submissionId: sub.id, from: current }
  if (!canStaffApprove(current)) return { status: "not_approvable", submissionId: sub.id, from: current }

  const now = new Date().toISOString()
  const history = Array.isArray(sub.review_history) ? [...sub.review_history] : []
  history.push(
    buildReviewHistoryEntry({
      from: current,
      to: "confirmed",
      at: now,
      by: params.by,
      actor: "staff",
      note: "Approved by staff — approval releases the submission (the client Confirm step was removed 2026-11-06)",
    }),
  )

  const { data: updated, error: updErr } = await supabaseAdmin
    .from("tax_return_submissions")
    .update({ review_status: "confirmed", review_history: history as never, updated_at: now })
    .eq("id", sub.id)
    .eq("review_status", current as string)
    .select("id")
  if (updErr) return { status: "error", submissionId: sub.id, from: current, detail: updErr.message }
  if (!updated || updated.length === 0) return { status: "conflict", submissionId: sub.id, from: current }

  // The open What's New card for this submission is done; a later resubmission raises a fresh one. Best-effort.
  await supabaseAdmin
    .from("message_actions")
    .update({ resolved_at: now })
    .eq("source_ref", `tax_submission:${sub.id}`)
    .is("resolved_at", null)

  const apply = await applyConfirmedTaxSubmission({ account_id: sub.account_id, tax_year: sub.tax_year, actor: `staff:${params.by}` })
  return { status: "approved", submissionId: sub.id, from: current, apply }
}

/** Does this outcome need a visible warning for the staff member who pressed Approve in the workspace? */
export function approvalNeedsWarning(status: ApproveTaxSubmissionResult["status"]): boolean {
  return (
    status !== "approved" &&
    status !== "already_released" &&
    status !== "no_submission" &&
    status !== "not_in_review" &&
    status !== "not_tax_flow"
  )
}
