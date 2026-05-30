/**
 * June (2nd) Installment Eligibility — pure decision function.
 *
 * Single source of truth for WHO the June `annual-installments` cron invoices,
 * skips, flags, or treats as already-done. Pure + DB-free so it is fully unit
 * tested; the cron supplies the DB-derived booleans.
 *
 * "Became our client" date (TD start) — the only reliable signal for Year-1 /
 * September. Date-driven precedence (decided with Antonio 2026-05-30):
 *   1. `ra_switch_date` → an ONBOARDED client (existing company came to us); the
 *      date we switched their registered agent to us is their start.
 *   2. `client_since`   → onboarding fallback when ra_switch_date is blank.
 *   3. `formation_date` → a client WE FORMED; formation is their start.
 *   (Never use `onboarding_date` — it is messy/conflicting.)
 *
 * Missing-start-date tripwire — FLAG (never bill) when EITHER:
 *   (1) there is no usable date at all (ra_switch_date, client_since AND
 *       formation_date all blank — genuinely un-dateable), OR
 *   (2) the account carries a "Client Onboarding" service but has neither
 *       ra_switch_date nor client_since (an onboarding client whose start we
 *       cannot trust the formation date for).
 * A normal formation client (formation_date present, no onboarding tag) is not
 * flagged. A forgotten start date can never cause a wrong bill.
 *
 * Year-1 (became our client in the billing year) is checked FIRST and skips the
 * whole year — the setup fee covers it. This OVERRIDES any first-installment
 * record, because the March-2026 bulk import injected fake "First Installment"
 * rows onto first-year clients who only ever paid a setup fee.
 *
 * Two regimes after that:
 *  - 2027 onward (permanent): gate on a signed annual agreement for the year.
 *  - 2026 (transition): owes the June installment if it has a 2026 first-
 *    installment record OR is a Sep–Dec prior-year start (September rule —
 *    January skipped, so June IS their installment). September-cohort clients are
 *    auto-invoiced the STANDARD June amount (no pro-rating exists in the model).
 *    No first installment AND not a Sep–Dec start → skip.
 *
 * Amount is ALWAYS the per-account CRM `installment_2_amount` — no hardcoded
 * default; missing/zero → `needs_amount` (skip + alert).
 *
 * Duplicate safety: if a 2nd-installment invoice already exists for the
 * account+year (by ANY route), the decision is `exists`.
 */

import { getRenewalGuard } from './renewal-guard'
import { isMissingStartDate } from './missing-start-date'

export type JuneInstallmentAction =
  | 'invoice'
  | 'skip'
  | 'flag'
  | 'exists'
  | 'needs_amount'

export interface JuneInstallmentDecision {
  action: JuneInstallmentAction
  /** Present only when action === 'invoice'. The CRM installment_2_amount. */
  amount?: number
  reason: string
}

export interface JuneInstallmentInput {
  /** Calendar year the cron is running for (e.g. 2026). */
  year: number
  account_type: string | null
  status: string | null
  is_test: boolean | null
  /** Per-account CRM second-installment amount. The ONLY amount source. */
  installment_2_amount: number | null
  /** Date we switched the client's registered agent to us (onboarded client).
   *  Highest-priority start date when present. */
  ra_switch_date: string | null
  /** Date the client was onboarded. Onboarding fallback when ra_switch_date is null. */
  client_since: string | null
  /** Date we formed the company. Used as the start when no onboarding date exists. */
  formation_date: string | null
  /** The account carries a "Client Onboarding" service (it is an onboarded
   *  client). Used only as the missing-start-date tripwire. */
  hasClientOnboardingService: boolean
  /** A first-installment record exists for `year` (paid, overdue, or waived). */
  hasFirstInstallmentThisYear: boolean
  /** A signed/completed annual agreement exists for `year` (2027+ gate). */
  hasSignedAgreementThisYear: boolean
  /** A 2nd-installment invoice already exists for `year` (any route). */
  hasExistingSecondInstallment: boolean
}

export function decideJuneInstallment(i: JuneInstallmentInput): JuneInstallmentDecision {
  // ── Hard exclusions: only Active Client, non-test accounts are ever billed.
  if (i.status !== 'Active') return { action: 'skip', reason: `status ${i.status ?? 'null'} not Active` }
  if (i.account_type !== 'Client') return { action: 'skip', reason: `account_type ${i.account_type ?? 'null'} not Client` }
  if (i.is_test === true) return { action: 'skip', reason: 'test account' }

  // ── Missing-start-date tripwire (two conditions, both required by Antonio):
  //    (1) NO usable date at all — RA switch, client since AND formation all
  //        blank → genuinely un-dateable.
  //    (2) a Client Onboarding account with no RA-switch/client-since → an
  //        onboarding client whose start we can't trust the formation date for.
  //    Either way: flag for manual review rather than bill off a wrong date.
  //    A normal formation client (formation_date present, no onboarding tag) is
  //    NOT flagged.
  if (isMissingStartDate(i)) {
    return { action: 'flag', reason: 'missing start date (no RA switch date, no client since) — set it in the CRM before billing' }
  }

  // ── "Became our client" date (date-driven): RA switch (onboarded) → client
  //    since (onboarding fallback) → formation date (we formed them).
  const tdStart = i.ra_switch_date || i.client_since || i.formation_date
  const { skipAccount, skipJanuary } = getRenewalGuard(tdStart, i.year)

  // ── Year-1 FIRST (overrides everything): became our client in the billing
  //    year → setup fee covers the whole year → no installment. Runs before the
  //    duplicate guard and the 1st-installment gate so a fake/mislabeled "1st
  //    installment" (March-2026 import) can never drag a first-year client in.
  if (skipAccount) {
    return { action: 'skip', reason: `Year-1 client (became our client ${tdStart ?? '?'}) — setup fee covers the first year` }
  }

  // ── Duplicate guard: never create a 2nd installment when one already exists
  //    for this year, regardless of how it was created (idempotency key + enum).
  if (i.hasExistingSecondInstallment) {
    return { action: 'exists', reason: `2nd installment already invoiced for ${i.year}` }
  }

  // ── Eligibility gate by regime.
  if (i.year >= 2027) {
    if (!i.hasSignedAgreementThisYear) {
      return { action: 'skip', reason: `no signed ${i.year} annual agreement` }
    }
  } else {
    // 2026 transition regime. A client owes the June installment when EITHER:
    //  - they have a 2026 first-installment record (normal: paid January → owes
    //    June), OR
    //  - they are a Sep–Dec prior-year start: January was skipped, so June IS
    //    their installment for the cycle. There is NO pro-rating in the model —
    //    they are billed the standard June installment, auto-invoiced like any
    //    other client (e.g. Zhang).
    // No first installment AND not a September-cohort start → not a 2026 biller.
    if (!i.hasFirstInstallmentThisYear && !skipJanuary) {
      return { action: 'skip', reason: `no ${i.year} first installment and not a Sep–Dec start` }
    }
  }

  // ── Amount strictly from CRM. No hardcoded default, ever. $0 / null → alert.
  const amount = i.installment_2_amount
  if (amount == null || amount <= 0) {
    return { action: 'needs_amount', reason: `installment_2_amount is ${amount == null ? 'null' : amount} — set the amount in the CRM before invoicing` }
  }

  return { action: 'invoice', amount, reason: 'eligible' }
}
