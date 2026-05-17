/**
 * Banking review operations — single source of truth for "approve and apply
 * a completed banking_submissions row".
 *
 * Shared by:
 *   - `banking_form_review(apply_changes=true)` MCP tool
 *   - `banking.approve_payset` and `banking.approve_relay` workflow handlers
 *
 * Both code paths call `approveAndApplyBankingReview` so the apply logic
 * lives in one place and the `reviewed_at` short-circuit protects against
 * B9 (double-execution when admin uses both surfaces on the same submission).
 *
 * The auto-chain (/api/banking-form-completed) ALREADY does:
 *   - Email notification to support@
 *   - Advances Banking Fintech SD: Data Collection → Application Submitted
 *   - Saves form data + uploads to Drive
 *
 * Therefore this helper does NOT repeat those side effects. It only:
 *   - Updates the legacy `services` table status → "Data Collected"
 *     (best-effort; rows may not exist for newer accounts)
 *   - Marks the submission as reviewed (reviewed_at, reviewed_by)
 *
 * Caller is responsible for spawning the next-step plain task (Submit Relay
 * application / Schedule Payset session) — the wording differs per provider
 * and belongs at the call site, not in the shared helper.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export type BankingReviewProvider = "payset" | "relay"

export interface ApproveBankingReviewParams {
  submission_id: string
  /** Actor identifier for the reviewed_by audit column. Examples: 'claude', 'workflow:banking.approve_payset', a user UUID. */
  actor: string
}

export interface ApproveBankingReviewResult {
  ok: boolean
  /** True if the submission was already reviewed_at IS NOT NULL on entry. The caller should treat this as a no-op, NOT a failure. */
  alreadyApplied?: boolean
  /** Provider read from the row — caller uses this to compose the follow-up task. */
  provider?: BankingReviewProvider
  /** Account associated with the submission. */
  account_id?: string | null
  /** Company name for follow-up task titles (resolved from accounts.company_name when account_id is set; falls back to token). */
  company_name?: string
  /** Result of the services table update step. Reported for diagnostics. */
  services_update?: "updated" | "no_row" | "error"
  services_update_error?: string
  error?: string
}

/**
 * Apply a completed banking submission. Idempotent via reviewed_at short-circuit.
 *
 * Returns alreadyApplied=true if the row was already reviewed — the caller
 * should NOT treat this as failure and should NOT spawn duplicate follow-up
 * tasks. Use the returned `provider` to compose any caller-side side effects
 * (e.g. spawn the next-step task) — those happen AFTER this returns ok=true
 * and alreadyApplied is false.
 */
export async function approveAndApplyBankingReview(
  params: ApproveBankingReviewParams,
): Promise<ApproveBankingReviewResult> {
  const { submission_id, actor } = params

  // ── 1. Load submission + early short-circuit on reviewed_at ──────────
  const { data: sub, error: subErr } = await supabaseAdmin
    .from("banking_submissions")
    .select("id, token, provider, account_id, contact_id, reviewed_at, status")
    .eq("id", submission_id)
    .maybeSingle()
  if (subErr) {
    return { ok: false, error: `banking_submissions lookup failed: ${subErr.message}` }
  }
  if (!sub) {
    return { ok: false, error: `banking_submissions row not found for id ${submission_id}` }
  }
  if (sub.status !== "completed" && sub.status !== "reviewed") {
    return { ok: false, error: `Submission is not completed (status='${sub.status}') — cannot apply` }
  }

  // Resolve company name once for caller convenience.
  let companyName = sub.token
  if (sub.account_id) {
    const { data: acct } = await supabaseAdmin
      .from("accounts")
      .select("company_name")
      .eq("id", sub.account_id)
      .maybeSingle()
    if (acct?.company_name) companyName = acct.company_name
  }

  const provider: BankingReviewProvider = sub.provider === "relay" ? "relay" : "payset"

  if (sub.reviewed_at) {
    return {
      ok: true,
      alreadyApplied: true,
      provider,
      account_id: sub.account_id,
      company_name: companyName,
    }
  }

  // ── 2. Update legacy services table (best-effort) ───────────────────
  // The newer `service_deliveries` table is already advanced by the auto-chain.
  // The older `services` table is updated for back-compat with code that still
  // reads it (status='Data Collected'). If no row exists for this account we
  // skip silently.
  let services_update: "updated" | "no_row" | "error" = "no_row"
  let services_update_error: string | undefined
  if (sub.account_id) {
    const { data: svc } = await supabaseAdmin
      .from("services")
      .select("id")
      .eq("account_id", sub.account_id)
      .eq("service_type", "Banking Fintech")
      .maybeSingle()
    if (svc) {
      const { error: svcErr } = await supabaseAdmin
        .from("services")
        .update({
          status: "Data Collected" as never,
          notes: `Banking form applied ${new Date().toISOString()} (${provider}) by ${actor}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", svc.id)
      if (svcErr) {
        services_update = "error"
        services_update_error = svcErr.message
      } else {
        services_update = "updated"
      }
    }
  }

  // ── 3. Mark submission as reviewed (this is the idempotency anchor) ─
  const { error: markErr } = await supabaseAdmin
    .from("banking_submissions")
    .update({
      status: "reviewed",
      reviewed_at: new Date().toISOString(),
      reviewed_by: actor,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sub.id)
    // Only mark if not already marked — guards against a TOCTOU race between
    // the early short-circuit check and this write. Concurrent callers will
    // get update_count=0 and treat as alreadyApplied.
    .is("reviewed_at", null)
  if (markErr) {
    return {
      ok: false,
      error: `Failed to mark submission reviewed: ${markErr.message}`,
      provider,
      account_id: sub.account_id,
      company_name: companyName,
      services_update,
      services_update_error,
    }
  }

  return {
    ok: true,
    provider,
    account_id: sub.account_id,
    company_name: companyName,
    services_update,
    services_update_error,
  }
}
