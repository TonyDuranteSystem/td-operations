/**
 * June (2nd) Installment Eligibility — pure decision function.
 *
 * Single source of truth for WHO the June `annual-installments` cron invoices,
 * skips, flags, or treats as already-done. Pure + DB-free so it is fully unit
 * tested; the cron supplies the DB-derived booleans.
 *
 * Two regimes:
 *  - 2027 onward (permanent): every client signs the annual agreement in
 *    January, so the gate is "has a signed agreement for this year".
 *  - 2026 (transition): agreements were not in use this year. The gate is
 *    Antonio's rule — "the client that was invoiced the 1st installment owes
 *    the 2nd" — i.e. has a first-installment record for the year. Clients with
 *    no 1st installment but a Sept–Dec prior-year start (post-September rule,
 *    January skipped) owe their first payment in June and are FLAGGED for
 *    manual handling, not auto-invoiced.
 *
 * Amount is ALWAYS the per-account CRM `installment_2_amount`. There is no
 * hardcoded default — a missing/zero amount returns `needs_amount` (skip +
 * alert), never a guessed invoice.
 *
 * Duplicate safety: if a 2nd-installment invoice already exists for the
 * account+year (by ANY route, including QB-imported rows with no idempotency
 * key), the decision is `exists` — the cron must not create a second one.
 */

import { getRenewalGuard } from './renewal-guard'

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
  onboarding_date: string | null
  formation_date: string | null
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

  // ── Duplicate guard (fixes the idempotency gap): never create a 2nd
  //    installment when one already exists for this year, regardless of how it
  //    was created (QB-imported / manual rows carry no idempotency key).
  if (i.hasExistingSecondInstallment) {
    return { action: 'exists', reason: `2nd installment already invoiced for ${i.year}` }
  }

  // ── Eligibility gate by regime.
  if (i.year >= 2027) {
    if (!i.hasSignedAgreementThisYear) {
      return { action: 'skip', reason: `no signed ${i.year} annual agreement` }
    }
  } else {
    // 2026 transition: paid/invoiced 1st → owes 2nd.
    if (!i.hasFirstInstallmentThisYear) {
      const { skipAccount, skipJanuary } = getRenewalGuard(
        i.onboarding_date || i.formation_date,
        i.year,
      )
      // Sept–Dec prior-year start: January was skipped, June is their FIRST
      // payment. Surface for manual handling rather than auto-invoicing.
      if (skipJanuary) {
        return { action: 'flag', reason: 'Sep–Dec prior-year start (skipped January) — owes June, manual review' }
      }
      // Started this year: setup fee covers the first year, no installment yet.
      if (skipAccount) {
        return { action: 'skip', reason: 'Year-1 client — setup fee covers first year' }
      }
      return { action: 'skip', reason: `no ${i.year} first installment` }
    }
  }

  // ── Amount strictly from CRM. No hardcoded default, ever. $0 / null → alert.
  const amount = i.installment_2_amount
  if (amount == null || amount <= 0) {
    return { action: 'needs_amount', reason: `installment_2_amount is ${amount == null ? 'null' : amount} — set the amount in the CRM before invoicing` }
  }

  return { action: 'invoice', amount, reason: 'eligible' }
}
