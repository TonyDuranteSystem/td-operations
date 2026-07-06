/**
 * Job Handler: country_policy_sweep (S4, 2026-07-06).
 *
 * Replays the workspace's active country policies (its own full-year answers ∪
 * the linked account's standing policies) over still-open located rows.
 * Enqueued by the AI chain's DONE branch — by then every AI-read place stamp
 * for this generation exists, so one sweep catches everything.
 *
 * Semantics (the 2026-07-05 lessons, applied from day one):
 *  - "Nothing to do" (no policies / no eligible rows) is SUCCESS.
 *  - A STALE workspace is SUCCESS-with-skip: new statements arrived after
 *    generation — the operator's Regenerate re-runs the chain, which re-enqueues
 *    this sweep. Failing the job would just burn generic retries on a state
 *    only a human action changes.
 *  - A thrown error fails the job → the queue's generic 3-attempt retry, then
 *    Exception Center.
 */

import type { Job, JobResult } from "../queue"

interface CountryPolicySweepPayload {
  workspace_id: string
}

export async function handleCountryPolicySweep(job: Job): Promise<JobResult> {
  const p = job.payload as unknown as CountryPolicySweepPayload
  const result: JobResult = { steps: [] }

  if (!p.workspace_id) {
    result.steps.push({ name: "validate", status: "error", detail: "Missing workspace_id", timestamp: new Date().toISOString() })
    result.ok = false
    result.summary = "Invalid country_policy_sweep payload"
    return result
  }

  const { runCountryPolicySweep } = await import("@/lib/tax/country-policy-sweep")
  const summary = await runCountryPolicySweep(p.workspace_id)

  const booked = summary.sweeps.filter(s => s.status === "ok" && (s.swept ?? 0) > 0)
  const detail = summary.sweeps.length === 0
    ? "no active country policies"
    : summary.sweeps.map(s => `${s.loc_code}:${s.status}${s.swept != null ? `(${s.swept})` : ""}`).join(", ")
  result.steps.push({ name: "country_policy_sweep", status: "ok", detail, timestamp: new Date().toISOString() })

  result.summary = summary.skippedAll && summary.reason
    ? `Country-policy sweep skipped — ${summary.reason} (${p.workspace_id})`
    : booked.length > 0
      ? `Country-policy sweep booked ${booked.reduce((n, s) => n + (s.swept ?? 0), 0)} row(s) across ${booked.length} countr${booked.length === 1 ? "y" : "ies"} (${p.workspace_id})`
      : `Country-policy sweep: nothing to book (${summary.policies} polic${summary.policies === 1 ? "y" : "ies"} checked, ${p.workspace_id})`
  return result
}
