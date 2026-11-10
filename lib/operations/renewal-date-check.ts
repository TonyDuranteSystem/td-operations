/**
 * Renewal-date check — pure helpers behind the Calendar's "renewal details"
 * pop-up and its "date doesn't match" list (dev job 51324085).
 *
 * Why this exists: the Registered Agent renewal date is the anniversary of the
 * day the agent service STARTED. Antonio's rule (2026-11-10): Client Since
 * filled = we onboarded a company they already had, so the renewal is the
 * anniversary of Client Since; Client Since empty = we created the company, so
 * it is the anniversary of Formation. Records created during the legacy import
 * carry the FORMATION anniversary even for onboarded companies (SD Int. LLC:
 * formed 2021-12-10, Client Since 2026-02-19, stored 2026-12-10; 33 of 43
 * onboarded clients on production on 2026-11-10). The system only ever FILLED
 * blank dates, so nothing noticed. These helpers let the Calendar show the
 * mismatch and let staff pick the right date.
 *
 * Nothing here writes. The suggestion is a SUGGESTION: it assumes every past
 * year was renewed on schedule, so the pop-up always says "confirm in Harbor".
 */

import { anniversaryForYear } from "@/lib/operations/renewal-dates"

// Server-side module (it imports the database layer through renewal-dates): the
// browser pop-up must import the reasons from renewal-correction-reasons instead.
export { CORRECTION_REASONS, CORRECTION_REASON_LABEL, type CorrectionReason } from "@/lib/operations/renewal-correction-reasons"

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** True for a real calendar date written YYYY-MM-DD (rejects 2026-02-31 etc.). */
export function isRealIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false
  const [y, m, d] = value.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/** Which date the renewal is measured from. */
export type RenewalStartBasis = "client_since" | "formation"

export interface RenewalStart {
  date: string
  basis: RenewalStartBasis
}

/**
 * The start of the Registered Agent service — Antonio's rule (2026-11-10):
 * **Client Since filled = we onboarded a company they already had, so the
 * renewal is the anniversary of Client Since. Client Since empty = we created
 * the company, so it is the anniversary of the Formation date.** The RA-switch
 * date and the old Onboarding date play no part. null = neither date is
 * recorded, nothing to compare.
 */
export function renewalCheckStart(account: {
  client_since: string | null
  formation_date: string | null
}): RenewalStart | null {
  if (account.client_since) {
    // Filled but unreadable → never fall back to Formation: that is the exact mistake this check exists to catch.
    return isRealIsoDate(account.client_since) ? { date: account.client_since, basis: "client_since" } : null
  }
  if (account.formation_date && isRealIsoDate(account.formation_date)) return { date: account.formation_date, basis: "formation" }
  return null
}

/** Every date the CRM holds for a company, as shown in the Calendar's pop-up. */
export interface CrmDates {
  formation: string | null
  onboarding: string | null
  clientSince: string | null
  raSwitch: string | null
  portalCreated: string | null
  raRenewal: string | null
  mailingAddress: string | null
  setupFee: string | null
  setupFeePaid: string | null
  cancellation: string | null
  remindersPausedUntil: string | null
}

export function crmDatesOf(a: {
  formation_date?: string | null
  onboarding_date?: string | null
  client_since?: string | null
  ra_switch_date?: string | null
  portal_created_date?: string | null
  ra_renewal_date?: string | null
  cmra_renewal_date?: string | null
  setup_fee_date?: string | null
  setup_fee_paid_date?: string | null
  cancellation_date?: string | null
  dunning_pause_until?: string | null
}): CrmDates {
  return {
    formation: a.formation_date ?? null,
    onboarding: a.onboarding_date ?? null,
    clientSince: a.client_since ?? null,
    raSwitch: a.ra_switch_date ?? null,
    portalCreated: a.portal_created_date ?? null,
    raRenewal: a.ra_renewal_date ?? null,
    mailingAddress: a.cmra_renewal_date ?? null,
    setupFee: a.setup_fee_date ?? null,
    setupFeePaid: a.setup_fee_paid_date ?? null,
    cancellation: a.cancellation_date ?? null,
    remindersPausedUntil: a.dunning_pause_until ?? null,
  }
}

/**
 * The next anniversary of `start` that falls on or after `today` (always at
 * least one year after the start — the service is renewed a year in).
 */
export function expectedRaRenewalDate(start: string | null | undefined, today: string): string | null {
  if (!start || !isRealIsoDate(start) || !isRealIsoDate(today)) return null
  const startYear = parseInt(start.slice(0, 4), 10)
  for (let year = startYear + 1; year <= startYear + 80; year++) {
    const candidate = anniversaryForYear(start, year)
    if (candidate >= today) return candidate
  }
  return null
}

/** Does the stored date fall on the anniversary of `start` (same month/day)? */
export function matchesStartAnniversary(stored: string, start: string): boolean {
  if (!isRealIsoDate(stored) || !isRealIsoDate(start)) return true // cannot judge → never raise a false alarm
  return anniversaryForYear(start, parseInt(stored.slice(0, 4), 10)) === stored
}

export interface RaDateCheck {
  /** The stored date sits on the anniversary of the RA start. */
  matches: boolean
  /** Next anniversary of the RA start on/after today (a suggestion). */
  expected: string | null
  /** The start date the check used. */
  start: string
  /** Which date that is: Client Since (we onboarded them) or Formation (we created the company). */
  basis: RenewalStartBasis
}

/** null = nothing to judge (no stored date, or no known RA start). */
export function checkRaDate(stored: string | null, start: RenewalStart | null, today: string): RaDateCheck | null {
  if (!stored || !start) return null
  return {
    matches: matchesStartAnniversary(stored, start.date),
    expected: expectedRaRenewalDate(start.date, today),
    start: start.date,
    basis: start.basis,
  }
}

/**
 * Sanity check on a date staff pick as the corrected one. The window is wide
 * enough for a record years behind, narrow enough to catch a typo like 2062.
 * Returns the problem in plain words, or null when the date is acceptable.
 */
export function validateCorrectedDate(to: unknown, today: string): string | null {
  if (!isRealIsoDate(to)) return "Pick a real date (YYYY-MM-DD)."
  const year = parseInt(to.slice(0, 4), 10)
  const thisYear = parseInt(today.slice(0, 4), 10)
  if (year < thisYear - 2 || year > thisYear + 3) {
    return `That date is far from today (${to}). Pick a date between ${thisYear - 2} and ${thisYear + 3}.`
  }
  return null
}
