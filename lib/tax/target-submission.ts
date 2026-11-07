/**
 * The tax submission a workspace button (and the review screen) acts on, loaded from the database.
 *
 * ONE rule, shared: the SAME submission the client's wizard gate lets them edit — when an open tax record exists, the oldest open
 * year's latest submission; otherwise the latest overall (see `pickTargetSubmission`). The review screen, Request Changes and the
 * written requests all go through this, so the answers staff look at, the requests they write and the form the client re-opens are
 * always ONE row.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { pickTargetSubmission } from "@/lib/tax/pick-target-submission"

export interface TargetSubmissionRow {
  id: string
  contact_id: string | null
  tax_year: number | null
  entity_type: string | null
  review_status: string | null
  review_history: unknown
  review_requests: unknown
  created_at: string
  submitted_data: Record<string, unknown> | null
  updated_at: string | null
}

export type LoadTargetResult =
  | { ok: true; account_id: string; sub: TargetSubmissionRow }
  | { ok: false; reason: "no_account" | "no_submission" | "error"; detail?: string; submissionId?: string }

const COLUMNS = "id, contact_id, tax_year, entity_type, review_status, review_history, review_requests, created_at, submitted_data, updated_at"

/** Load the target submission of a company (account). The caller has already decided the service is a tax-family job. */
export async function loadTargetTaxSubmission(accountId: string | null): Promise<LoadTargetResult> {
  if (!accountId) return { ok: false, reason: "no_account" }
  const [subsRes, openRes] = await Promise.all([
    supabaseAdmin.from("tax_return_submissions").select(COLUMNS).eq("account_id", accountId),
    supabaseAdmin.from("tax_returns").select("tax_year").eq("account_id", accountId).eq("data_received", false),
  ])
  if (subsRes.error) return { ok: false, reason: "error", detail: subsRes.error.message }
  if (openRes.error) return { ok: false, reason: "error", detail: openRes.error.message }
  const openYears = (openRes.data ?? []).map((r) => r.tax_year as number)
  const sub = pickTargetSubmission((subsRes.data ?? []) as unknown as TargetSubmissionRow[], openYears)
  if (!sub) return { ok: false, reason: "no_submission" }
  return { ok: true, account_id: accountId, sub }
}
