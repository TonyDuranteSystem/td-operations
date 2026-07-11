/**
 * Point-of-work issue counts. Reuses the EXISTING client diagnostic (the same
 * code the Issues tab renders) in-process — so the cached ⚠️ count can never
 * drift from what the tab shows, and there's no HTTP/auth hole. The full
 * diagnostic + one-click fixes still run live in the tab; this only fills the
 * cheap per-client cache (client_issue_counts) that feeds the list indicators.
 */
import { NextRequest } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { GET as diagnoseAccount } from "@/app/api/crm/admin-actions/diagnose-account/route"

// client_issue_counts isn't in the generated types yet (new table).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export interface IssueCount {
  error_count: number
  warning_count: number
}

/** Run the live diagnostic for one account and tally error/warning checks. */
export async function computeIssueCount(accountId: string): Promise<IssueCount> {
  const req = new NextRequest(
    `http://internal/api/crm/admin-actions/diagnose-account?account_id=${encodeURIComponent(accountId)}`,
  )
  const res = await diagnoseAccount(req)
  const data = (await res.json()) as { checks?: Array<{ status?: string }> }
  const checks = Array.isArray(data.checks) ? data.checks : []
  return {
    error_count: checks.filter((c) => c.status === "error").length,
    warning_count: checks.filter((c) => c.status === "warning").length,
  }
}

/** Compute + upsert the cached count for one account. Returns the fresh count. */
export async function refreshIssueCount(accountId: string, now: string): Promise<IssueCount> {
  const count = await computeIssueCount(accountId)
  await db.from("client_issue_counts").upsert(
    {
      account_id: accountId,
      error_count: count.error_count,
      warning_count: count.warning_count,
      checked_at: now,
    },
    { onConflict: "account_id" },
  )
  return count
}
