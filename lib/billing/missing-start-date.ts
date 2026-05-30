/**
 * Missing client start-date detection — single source of truth.
 *
 * A client's "start date" (when they became our client) drives Year-1 / September
 * billing decisions. It is resolved date-driven: ra_switch_date → client_since →
 * formation_date. A client is "missing" its start date — and must be surfaced for
 * a human to fill rather than billed off a wrong/stale date — when EITHER:
 *   (1) there is no usable date at all (ra_switch_date, client_since AND
 *       formation_date all blank), OR
 *   (2) it carries a "Client Onboarding" service but has neither ra_switch_date
 *       nor client_since (an onboarding client whose formation date we can't trust).
 *
 * The June installment cron uses this same predicate for its FLAG decision, so
 * the cron and the (future) "What's New" / staff alert never disagree.
 *
 * Pure + DB-free → fully unit tested. The DB list query lives in
 * findActiveClientsMissingStartDate() below.
 */

export interface StartDateFields {
  ra_switch_date: string | null
  client_since: string | null
  formation_date: string | null
  /** The account carries a "Client Onboarding" service (it is an onboarded client). */
  hasClientOnboardingService: boolean
}

/** True when the account has no trustworthy start date and must be flagged. Pure. */
export function isMissingStartDate(a: StartDateFields): boolean {
  return !a.ra_switch_date && !a.client_since && (a.hasClientOnboardingService || !a.formation_date)
}
