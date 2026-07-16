/**
 * Tax-form completion sweep — eligibility + result parsing (pure helpers).
 *
 * The external tax form triggers its post-completion chain
 * (/api/tax-form-completed) from the CLIENT's browser, fire-and-forget with a
 * swallowed catch. When that call fails nothing notices — in spring 2026,
 * 5 of 12 external submissions silently got no team email / review dispatch
 * (Rocco Papotti incident, dev job 1784f940). The sweep cron re-fires the
 * chain server-side for external rows whose chain marker (review_status, set
 * at the route's step 4C) is still empty.
 *
 * INVARIANT this predicate leans on: for EXTERNAL rows, the completion
 * route's step 4C is the sole first writer of review_status. The portal
 * wizard writes review_status synchronously at submit and never writes
 * completed_at, and its tokens are prefixed "portal-" — three independent
 * reasons wizard rows are excluded here. If any of that changes, revisit
 * this predicate (docs/systems/tax-returns.md, completion auto-chain gotcha).
 */

/** Feature birth. Rows completed before this are handled manually — the 5
 *  known spring misses were handed to Luca via team chat on 2026-07-16;
 *  re-firing months-old chains would email stale client state. */
export const SWEEP_CUTOFF_ISO = "2026-07-16T00:00:00Z"

/** Let the direct browser fire win: the chain runs ≤60s, so a 30-minute grace
 *  window makes racing an in-flight run (duplicate team email, duplicate
 *  review-history entry) practically impossible. */
export const SWEEP_GRACE_MINUTES = 30

/** Each rescued chain can legitimately take up to ~60s (Drive copy, bank
 *  statement parse). Keep the sweep well inside its own function window. */
export const SWEEP_MAX_FIRES_PER_RUN = 3

/** After this many fires for one row, stop re-firing (each fire can resend
 *  the team email) and only alert — a persistently failing marker step needs
 *  a human, not a 48-emails-a-day loop. */
export const SWEEP_MAX_ATTEMPTS = 3

/** financials_meta key holding the per-row fire counter. */
export const SWEEP_ATTEMPTS_KEY = "completion_sweep_attempts"

export interface SweepCandidate {
  status: string | null
  completed_at: string | null
  review_status: string | null
  token: string | null
}

export function sweepAttempts(meta: Record<string, unknown> | null | undefined): number {
  const n = Number((meta ?? {})[SWEEP_ATTEMPTS_KEY])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export function isSweepEligible(row: SweepCandidate, now: Date): boolean {
  if (row.status !== "completed") return false
  // Portal-wizard rows never carry completed_at (buildSubmissionRecord omits
  // it) — this also keeps them out even if the token check below drifts.
  if (!row.completed_at) return false
  if (row.review_status !== null && row.review_status !== undefined) return false
  if ((row.token ?? "").startsWith("portal-")) return false
  const completed = Date.parse(row.completed_at)
  if (Number.isNaN(completed)) return false
  if (completed < Date.parse(SWEEP_CUTOFF_ISO)) return false
  if (completed > now.getTime() - SWEEP_GRACE_MINUTES * 60_000) return false
  return true
}

/**
 * The chain route always answers HTTP 200 with per-step results — success for
 * the sweep means the review_status marker step ran, NOT the HTTP status.
 * Anything in errorSteps is surfaced even when the marker succeeded.
 */
export function parseChainResults(body: unknown): { markerOk: boolean; errorSteps: string[] } {
  const results = (body as { results?: { step?: string; status?: string; detail?: string }[] } | null)?.results
  if (!Array.isArray(results)) return { markerOk: false, errorSteps: ["no results array in response"] }
  const errorSteps = results
    .filter(r => r?.status === "error")
    .map(r => `${r.step ?? "unknown"}: ${r.detail ?? ""}`.trim())
  const markerOk = results.some(r => r?.step === "review_status" && r?.status === "ok")
  return { markerOk, errorSteps }
}
