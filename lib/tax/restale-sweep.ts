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
}

export interface RestaleDecision {
  eligible: boolean
  reason:
    | "eligible"
    | "no_transactions"
    | "already_confirmed"
}

/**
 * May the sweep re-sort this account-year?
 *
 * Two refusals, both deliberate:
 *  - `already_confirmed` — the client has signed off on those numbers. Moving
 *    a figure under a confirmed return would change what somebody attested to.
 *    A confirmed return is corrected by staff reopening it, never by a cron.
 *  - `no_transactions` — nothing to sort; skip the work.
 *
 * Note what is NOT a refusal: rows the client or staff answered by hand. Those
 * carry a "manual:" note and the engine already refuses to touch them, so the
 * sweep cannot overwrite a human decision no matter how often it runs.
 */
export function decideRestale(c: RestaleCandidate): RestaleDecision {
  if (c.confirmed) return { eligible: false, reason: "already_confirmed" }
  if (c.transactions <= 0) return { eligible: false, reason: "no_transactions" }
  return { eligible: true, reason: "eligible" }
}

/** Biggest account-year seen in production is ~10k rows; the deterministic
 *  pass is pure CPU plus one chunked update. Cap the run anyway so a future
 *  book ten times this size can never blow the function window — the leftovers
 *  are simply picked up on the next tick. */
export const RESTALE_MAX_ACCOUNTS_PER_RUN = 8

/** Report-only unless this is explicitly set to the string "false", matching
 *  the other tax sweeps. A sweep that rewrites client money must be watched
 *  before it is trusted. */
export function restaleIsDryRun(env: Record<string, string | undefined>): boolean {
  return env.TAX_RESTALE_SWEEP_DRY_RUN !== "false"
}

/** One line per account-year, for the run log and the team alert. */
export function describeRestaleResult(r: {
  company: string
  taxYear: number
  scanned: number
  changed: number
  dryRun: boolean
}): string {
  const verb = r.dryRun ? "would change" : "changed"
  return `${r.company} ${r.taxYear}: ${verb} ${r.changed} of ${r.scanned}`
}
