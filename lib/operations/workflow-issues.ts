/**
 * Firm-wide workflow dispatch issues.
 *
 * Reads workflow_dispatch_log for the PROBLEM outcomes (the silent failures:
 * no-match / ambiguous / invalid / spawn-failed) across all accounts — and,
 * importantly, those with NO account attached (e.g. a form that didn't link to
 * a client), which can never appear on a client page. Successful spawns and
 * benign webhook-retry no-ops are excluded.
 *
 * Powers the /workflow-issues page (a Tools-hub tile) and the per-account
 * filtered view linked from the account page.
 *
 * No foreign key exists on workflow_dispatch_log (an audit log must never fail
 * to write), so account names are resolved with a second query and merged.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export const DISPATCH_PROBLEM_OUTCOMES = [
  "no_trigger_match",
  "ambiguous",
  "snapshot_invalid",
  "meta_invalid",
  "spawn_failed",
] as const

export interface WorkflowIssue {
  id: string
  created_at: string
  trigger_source: string
  event_descriptor: string | null
  outcome: string
  matched_workflow_slug: string | null
  candidates: string[] | null
  account_id: string | null
  contact_id: string | null
  /** Resolved company name when account_id is set; null otherwise. */
  account_name: string | null
}

/** Plain-language label for a dispatch outcome. Pure — unit-tested. */
export function dispatchOutcomeLabel(outcome: string): string {
  switch (outcome) {
    case "no_trigger_match": return "No matching workflow"
    case "ambiguous": return "Ambiguous match"
    case "snapshot_invalid": return "Invalid workflow snapshot"
    case "meta_invalid": return "Invalid task data"
    case "spawn_failed": return "Spawn failed"
    default: return outcome
  }
}

/** Plain-language label for the trigger source. Pure — unit-tested. */
export function dispatchSourceLabel(source: string): string {
  switch (source) {
    case "form_submission": return "Form submission"
    case "sd_created": return "Service created"
    case "chain": return "Chain step"
    default: return source
  }
}

/**
 * Ambiguous / no-match are configuration smells; the rest are genuine
 * failures. Pure — unit-tested. Returns 'warn' | 'error'.
 */
export function dispatchSeverity(outcome: string): "warn" | "error" {
  return outcome === "ambiguous" || outcome === "no_trigger_match" ? "warn" : "error"
}

export interface GetWorkflowIssuesOpts {
  /** Restrict to one account (for the per-account view). */
  accountId?: string
  /** Max rows. Default 100. */
  limit?: number
}

export async function getWorkflowIssues(opts: GetWorkflowIssuesOpts = {}): Promise<WorkflowIssue[]> {
  const limit = opts.limit ?? 100

  let query = supabaseAdmin
    .from("workflow_dispatch_log")
    .select("id, created_at, trigger_source, event_descriptor, outcome, matched_workflow_slug, candidates, account_id, contact_id")
    .in("outcome", DISPATCH_PROBLEM_OUTCOMES as unknown as string[])
    .order("created_at", { ascending: false })
    .limit(limit)

  if (opts.accountId) {
    query = query.eq("account_id", opts.accountId)
  }

  const { data, error } = await query
  if (error || !data) return []

  // Resolve account names in one follow-up query (no FK on the log table).
  const accountIds = Array.from(new Set(data.map(r => r.account_id).filter((x): x is string => !!x)))
  const nameById = new Map<string, string | null>()
  if (accountIds.length > 0) {
    const { data: accts } = await supabaseAdmin
      .from("accounts")
      .select("id, company_name")
      .in("id", accountIds)
    for (const a of accts ?? []) nameById.set(a.id, a.company_name ?? null)
  }

  return data.map(r => ({
    id: r.id,
    created_at: r.created_at,
    trigger_source: r.trigger_source,
    event_descriptor: r.event_descriptor,
    outcome: r.outcome,
    matched_workflow_slug: r.matched_workflow_slug,
    candidates: (r.candidates as string[] | null) ?? null,
    account_id: r.account_id,
    contact_id: r.contact_id,
    account_name: r.account_id ? (nameById.get(r.account_id) ?? null) : null,
  }))
}

/** Count of open workflow issues for one account. Used by the account-page link. */
export async function getWorkflowIssueCountForAccount(accountId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("workflow_dispatch_log")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .in("outcome", DISPATCH_PROBLEM_OUTCOMES as unknown as string[])
  if (error || count == null) return 0
  return count
}
