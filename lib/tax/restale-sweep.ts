/**
 * Stale-classification sweep — pure eligibility helpers.
 *
 * WHY THIS EXISTS (2026-08-03, LT Program / TP Balance).
 * A client's bank transactions are sorted into categories ONCE, by
 * `recategorizeAccountYear`, at the moment statements are ingested (and again
 * on a staff workspace save, or a manual re-run from the MCP tool). Nothing
 * re-runs it when the CLIENT RECORD later improves — and the record is an
 * input to the sort:
 *
 *   - member names (from account_contacts) decide owner draws / contributions
 *   - the company's legal name decides own-entity self-transfer detection
 *   - declared related companies decide related-party flags
 *
 * Live consequence: five payments to Lucia Terracciano and Antonio Pezzella
 * were booked as internal transfers instead of owner draws — money out to a
 * named member IS an owner draw and the engine knows it, but those two people
 * were linked as contacts on their accounts AFTER their statements were
 * ingested, so the rule never got the chance to fire. Hidden as "transfers"
 * the money reached neither the P&L nor the members' capital accounts.
 *
 * THE ENGINE WAS ALREADY CAPABLE. `computeRecategorizationUpdates` pass 1
 * re-applies the rules to EVERY row (not only uncategorized ones) and writes
 * whenever the computed category differs from the stored one, so a re-run
 * would have corrected those rows on its own. What was missing was purely a
 * trigger. This sweep is that trigger.
 *
 * SHAPE: a periodic safety net, not a write-site hook — deliberately. Hooking
 * every place that links a contact or renames a company is the failure mode
 * that produced this bug in the first place (one missed call site = silent
 * wrong money). A sweep catches every path including CRM edits and direct
 * database changes.
 */

/** Account-year the sweep may touch. */
export interface RestaleCandidate {
  account_id: string
  tax_year: number
  /** Rows present for that account-year — 0 means nothing to sort. */
  transactions: number
  /** True once the CLIENT has attested the financials. */
  confirmed: boolean
  /**
   * The review state of the account-year's submissions. "Finished or in
   * somebody's hands" is TWO independent signals and checking only one is not
   * enough: `confirmation_accepted` records the client's attestation, while
   * `review_status` records where the return sits in the staff review loop.
   * A return can be `confirmed` in the review loop, and staff can be actively
   * working one (`under_review`) — neither should have a cron re-sorting the
   * numbers underneath it. Pass every review_status found for the account-year;
   * the safest one wins.
   */
  reviewStatuses?: (string | null)[]
}

export interface RestaleDecision {
  eligible: boolean
  reason:
    | "eligible"
    | "no_transactions"
    | "already_confirmed"
    | "staff_reviewing"
}

/** Review states where a background job must keep its hands off. Exported so
 *  any other automated writer can share this exact definition instead of
 *  re-deriving it — the chain watchdog's confirmed-submission guard
 *  (chain-watchdog.ts) reuses it rather than duplicating the two literals. */
export const HANDS_OFF_REVIEW_STATUSES: ReadonlySet<string> = new Set(["confirmed", "under_review"])

/**
 * Is this account-year off-limits to a BACKGROUND writer right now — the
 * client has attested (`confirmed`), or staff is actively working it (a
 * review_status in HANDS_OFF_REVIEW_STATUSES)? `confirmation_accepted` alone
 * is not proof a return is still open — a return marked `confirmed` in the
 * review loop, or one a staff member is actively reviewing, is equally
 * off-limits (QA 2026-08-04). One hands-off row among several protects the
 * whole account-year.
 *
 * Shared by `decideRestale` below and the AI-chain watchdog's
 * confirmed-submission guard (chain-watchdog.ts) — one definition of
 * "hands off", used everywhere a background job might otherwise touch a
 * client's numbers after they signed off.
 */
export function isAccountYearHandsOff(c: { confirmed: boolean; reviewStatuses?: (string | null)[] }): boolean {
  if (c.confirmed) return true
  return (c.reviewStatuses ?? []).some(s => s !== null && HANDS_OFF_REVIEW_STATUSES.has(s))
}

/**
 * May the sweep re-sort this account-year?
 *
 * Two refusals, both deliberate:
 *  - `already_confirmed` / `staff_reviewing` — see isAccountYearHandsOff.
 *    A confirmed return is corrected by staff reopening it, never by a cron.
 *  - `no_transactions` — nothing to sort; skip the work.
 *
 * Note what is NOT a refusal: rows the client or staff answered by hand. Those
 * carry a "manual:" note and the engine already refuses to touch them, so the
 * sweep cannot overwrite a human decision no matter how often it runs.
 */
export function decideRestale(c: RestaleCandidate): RestaleDecision {
  if (isAccountYearHandsOff(c)) {
    return c.confirmed ? { eligible: false, reason: "already_confirmed" } : { eligible: false, reason: "staff_reviewing" }
  }
  if (c.transactions <= 0) return { eligible: false, reason: "no_transactions" }
  return { eligible: true, reason: "eligible" }
}

/**
 * Runaway guard, NOT a work-sharing batch size.
 *
 * The first cut set this to 8 and took the SMALLEST account-years first with
 * no record of what had already been swept — so the same tiny account-years
 * were reprocessed forever and the ones this job was built for were never
 * reached (16 account-years exist today). Correcting the ordering is not
 * enough on its own: without a cursor, a cap below the total starves the tail
 * permanently. So the cap sits comfortably ABOVE the whole book and the route
 * REPORTS any overflow rather than dropping it silently. If the book ever
 * outgrows one run, the honest fix is a swept-at marker, not a bigger number.
 */
export const RESTALE_MAX_ACCOUNTS_PER_RUN = 40

/** Report-only unless this is explicitly set to the string "false", matching
 *  the other tax sweeps. A sweep that rewrites client money must be watched
 *  before it is trusted. */
export function restaleIsDryRun(env: Record<string, string | undefined>): boolean {
  return env.TAX_RESTALE_SWEEP_DRY_RUN !== "false"
}

/**
 * TIME BUDGET, not just an account cap.
 *
 * The runaway guard counts ACCOUNTS, but the ceiling that actually bites is
 * wall-clock: the route has 300s and the work is one UPDATE round-trip per
 * changed row. Killed mid-loop, rows are already rewritten and the team post —
 * which happens only after the loop — never runs, breaking this job's own
 * promise to never re-sort in silence. Worse, the ordering is a fixed sort with
 * no cursor, so every later run re-sweeps the same leading accounts and the
 * tail starves: exactly the bug the account cap was raised to fix, returning
 * through the time door.
 *
 * Pure so it can be tested without a clock.
 */
export const RESTALE_TIME_BUDGET_MS = 240_000

export function sweepBudgetExhausted(startedMs: number, nowMs: number): boolean {
  return nowMs - startedMs >= RESTALE_TIME_BUDGET_MS
}

/** One line per account-year, for the run log and the team alert. */
export function describeRestaleResult(r: {
  company: string
  taxYear: number
  scanned: number
  changed: number
  marks?: number
  dryRun: boolean
}): string {
  const verb = r.dryRun ? "would change" : "changed"
  const marks = r.marks
    ? ` · ${r.marks} owner question${r.marks === 1 ? "" : "s"} ${r.dryRun ? "would be raised/cleared" : "raised/cleared"}`
    : ""
  return `${r.company} ${r.taxYear}: ${verb} ${r.changed} of ${r.scanned}${marks}`
}
