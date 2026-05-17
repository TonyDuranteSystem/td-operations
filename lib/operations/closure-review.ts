/**
 * Closure review operations — single source of truth for "approve the
 * client-submitted closure form".
 *
 * Shared by:
 *   - `closure_form_review(mark_reviewed=true)` MCP tool
 *   - `closure.approve_data` workflow handler (closure_progress workflow's
 *      first action — Data Collection → State Compliance Check)
 *
 * Both code paths call `approveAndApplyClosureReview` so the apply logic
 * lives in one place and the `reviewed_at IS NULL` short-circuit protects
 * against B9 double-execution.
 *
 * The closure auto-chain (/api/closure-form-completed) already:
 *   - Sends Luca an email
 *   - Saves form data + uploads to Drive (or it WILL once the workflow
 *     replaces the legacy plain task — for now Drive save happens both in
 *     the route and again in the apply path, idempotent enough)
 *   - Ensures the SD exists
 *   - Updates SD history
 *
 * This helper does the apply-specific part:
 *   - Save form data + uploaded docs to Drive (idempotent against the
 *     auto-chain's earlier save — saveFormToDrive overwrites by filename)
 *   - Mark the submission reviewed_at + reviewed_by
 *
 * No follow-up task creation here — the workflow handler advances the SD
 * stage which is the equivalent next-step signal.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export interface ApproveClosureReviewParams {
  submission_id: string
  /** Actor for the reviewed_by audit column. */
  actor: string
}

export interface ApproveClosureReviewResult {
  ok: boolean
  alreadyApplied?: boolean
  /** Token (used by callers that want to log it / link to it). */
  token?: string
  /** Account associated with the submission. May be null (closure can be lead-only). */
  account_id?: string | null
  /** Company name for downstream display (resolved from submitted_data.llc_name or lead/contact, falls back to token). */
  company_name?: string
  /** Result of Drive save step. */
  drive_save?: "ok" | "skipped" | "error"
  drive_save_error?: string
  error?: string
}

export async function approveAndApplyClosureReview(
  params: ApproveClosureReviewParams,
): Promise<ApproveClosureReviewResult> {
  const { submission_id, actor } = params

  // ── 1. Load submission + early short-circuit on reviewed_at ──────────
  const { data: sub, error: subErr } = await supabaseAdmin
    .from("closure_submissions")
    .select(
      "id, token, account_id, contact_id, lead_id, status, reviewed_at, submitted_data, upload_paths, completed_at, language",
    )
    .eq("id", submission_id)
    .maybeSingle()
  if (subErr) {
    return { ok: false, error: `closure_submissions lookup failed: ${subErr.message}` }
  }
  if (!sub) {
    return { ok: false, error: `closure_submissions row not found for id ${submission_id}` }
  }
  if (sub.status !== "completed" && sub.status !== "reviewed") {
    return { ok: false, error: `Submission is not completed (status='${sub.status}') — cannot apply` }
  }

  // Resolve company name for caller convenience + Drive save context.
  const submitted = (sub.submitted_data || {}) as Record<string, unknown>
  let companyName = (submitted.llc_name as string | undefined) || sub.token
  if (!submitted.llc_name) {
    if (sub.lead_id) {
      const { data: lead } = await supabaseAdmin
        .from("leads")
        .select("full_name")
        .eq("id", sub.lead_id)
        .maybeSingle()
      if (lead?.full_name) companyName = lead.full_name
    } else if (sub.contact_id) {
      const { data: contact } = await supabaseAdmin
        .from("contacts")
        .select("full_name")
        .eq("id", sub.contact_id)
        .maybeSingle()
      if (contact?.full_name) companyName = contact.full_name
    }
  }

  if (sub.reviewed_at) {
    return {
      ok: true,
      alreadyApplied: true,
      token: sub.token,
      account_id: sub.account_id,
      company_name: companyName,
    }
  }

  // ── 2. Save form data + uploads to Drive (best-effort) ──────────────
  let drive_save: "ok" | "skipped" | "error" = "skipped"
  let drive_save_error: string | undefined
  if (sub.account_id) {
    try {
      const { data: acct } = await supabaseAdmin
        .from("accounts")
        .select("drive_folder_id")
        .eq("id", sub.account_id)
        .maybeSingle()
      if (acct?.drive_folder_id) {
        const { saveFormToDrive } = await import("@/lib/form-to-drive")
        await saveFormToDrive(
          "closure",
          submitted,
          (sub.upload_paths as string[]) || [],
          acct.drive_folder_id,
          {
            token: sub.token,
            submittedAt: sub.completed_at || new Date().toISOString(),
            companyName,
          },
        )
        drive_save = "ok"
      }
    } catch (err) {
      drive_save = "error"
      drive_save_error = err instanceof Error ? err.message : String(err)
    }
  }

  // ── 3. Mark submission as reviewed (idempotency anchor) ─────────────
  const { error: markErr } = await supabaseAdmin
    .from("closure_submissions")
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
      token: sub.token,
      account_id: sub.account_id,
      company_name: companyName,
      drive_save,
      drive_save_error,
    }
  }

  return {
    ok: true,
    token: sub.token,
    account_id: sub.account_id,
    company_name: companyName,
    drive_save,
    drive_save_error,
  }
}
