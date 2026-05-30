/**
 * June (2nd) Installment Eligibility — pure decision function.
 *
 * Single source of truth for WHO the June `annual-installments` cron invoices,
 * skips, flags, or treats as already-done. Pure + DB-free so it is fully unit
 * tested; the cron supplies the DB-derived booleans.
 *
 * "Became our client" date (TD start) — the only reliable signal for Year-1 /
 * September:
 *   - `client_since` if present  → the client was ONBOARDED (existing company
 *     that came to us); that date is their start. Formation date is IGNORED.
 *   - else `formation_date`      → a client WE FORMED; formation is their start.
 *   (Never use `onboarding_date` — it is messy/conflicting.)
 *
 * Year-1 (became our client in the billing year) is checked FIRST and skips the
 * whole year — the setup fee covers it. This OVERRIDES any first-installment
 * record, because the March-2026 bulk import injected fake "First Installment"
 * rows onto first-year clients who only ever paid a setup fee.
 *
 * Two regimes after that:
 *  - 2027 onward (permanent): gate on a signed annual agreement for the year.
 *  - 2026 (transition): gate on "has a first-installment record for the year".
 *    Clients with no 1st installment but a Sep–Dec prior-year start (September
 *    rule, January skipped) owe their FIRST payment in June → FLAGGED for manual
 *    handling, not auto-invoiced.
 *
 * Amount is ALWAYS the per-account CRM `installment_2_amount` — no hardcoded
 * default; missing/zero → `needs_amount` (skip + alert).
 *
 * Duplicate safety: if a 2nd-installment invoice already exists for the
 * account+year (by ANY route), the decision is `exists`.
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
  /** Date the client was onboarded (existing company came to us). The start
   *  date when present; formation_date is ignored when this is set. */
  client_since: string | null
  /** Date we formed the company. Used as the start ONLY when client_since is null. */
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

  // ── "Became our client" date: client_since (onboarded) ELSE formation_date
  //    (we formed them). Never onboarding_date.
  const tdStart = i.client_since || i.formation_date
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
    // 2026 transition: paid/invoiced 1st → owes 2nd.
    if (!i.hasFirstInstallmentThisYear) {
      // Sep–Dec prior-year start: January was skipped, June is their FIRST
      // payment. Surface for manual handling rather than auto-invoicing.
      if (skipJanuary) {
        return { action: 'flag', reason: 'Sep–Dec prior-year start (skipped January) — owes June, manual review' }
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
