/**
 * TD Communication — Phase 13 revenue & payout pure logic (no DB / no I/O).
 *
 * The two-stage model:
 *   1. RECOGNIZED — an earning is locked when the project first reaches
 *      approved/delivered (`earning_locked_at`). It counts as "earned" but is
 *      NOT yet withdrawable.
 *   2. AVAILABLE — the earning becomes withdrawable only once the client has
 *      paid (linked `payments` row status='Paid', OR an admin off-platform
 *      override). This honors the firm's "pay the partner after the client
 *      pays" rule (lib/portal/partner-referrals.ts).
 *
 * Cris's payouts are `referral_payouts` rows discriminated by
 * payout_type='td_comm' (referral_id IS NULL). Balance is drawn down by every
 * non-rejected payout (bank-account model — no per-earning reservation).
 *
 * Side-effect-free so it is unit-testable without a database (R086).
 */

import type { EnrollmentStatus, EnrollmentSubjectType } from './types'

/** Discriminator that separates TD-Communication payouts from referral payouts. */
export const TD_COMM_PAYOUT_TYPE = 'td_comm'

/** The exact `payments.status` value that means the client has paid. */
export const PAYMENT_PAID_STATUS = 'Paid'

/** Allowed payout methods (mirrors the existing partner-actions mark-paid gate). */
export const PAYOUT_METHODS = ['bank_transfer', 'credit_note', 'invoice_deduction'] as const
export type PayoutMethod = (typeof PAYOUT_METHODS)[number]

/** Payout lifecycle statuses used by the reused referral_payouts route (+ reject). */
export type PayoutStatus =
  | 'pending'
  | 'manual_review'
  | 'requested'
  | 'approved'
  | 'paid'
  | 'rejected'

/** A payout that is NOT this one draws down available balance (everything but rejected). */
export function reservesBalance(status: string | null | undefined): boolean {
  return status !== 'rejected'
}

/* -------------------------------------------------------------------------- */
/* Input shapes (minimal — decoupled from the DB row types)                    */
/* -------------------------------------------------------------------------- */

/** The revenue-relevant fields of a td_comm_enrollments row. */
export interface RevenueEnrollment {
  id: string
  status: EnrollmentStatus
  partner_amount_usd: number | string | null
  earning_locked_at: string | null
  worker_partner_id: string | null
  client_payment_id: string | null
  client_paid_override_at: string | null
}

/** The linked client invoice (payments row) for an enrollment. */
export interface LinkedPayment {
  id: string
  status: string | null
  total: number | string | null
}

/** A TD-Communication payout row (referral_payouts, payout_type='td_comm'). */
export interface TdCommPayout {
  id: string
  amount: number | string | null
  status: string | null
}

/* -------------------------------------------------------------------------- */
/* Core predicates                                                             */
/* -------------------------------------------------------------------------- */

/** Coerce a possibly-string/null numeric column to a finite number (never NaN). */
export function toAmount(v: number | string | null | undefined): number {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

/** Cris's earning for this project (0 when unset). */
export function earningAmount(e: RevenueEnrollment): number {
  return toAmount(e.partner_amount_usd)
}

/** Recognized = the earning is locked and the project is not cancelled. */
export function isRecognized(e: RevenueEnrollment): boolean {
  return e.earning_locked_at !== null && e.status !== 'cancelled'
}

/** Has the client paid for this project (Paid invoice OR admin override)? */
export function clientHasPaid(e: RevenueEnrollment, payment?: LinkedPayment | null): boolean {
  if (e.client_paid_override_at !== null) return true
  return payment != null && payment.status === PAYMENT_PAID_STATUS
}

/** Available = recognized AND the client has paid → the earning is withdrawable. */
export function isAvailable(e: RevenueEnrollment, payment?: LinkedPayment | null): boolean {
  return isRecognized(e) && clientHasPaid(e, payment)
}

/* -------------------------------------------------------------------------- */
/* Balance                                                                     */
/* -------------------------------------------------------------------------- */

export interface PartnerBalance {
  /** Recognized but the client hasn't paid yet — "Earned, waiting on client payment". */
  earnedWaiting: number
  /** Recognized AND client-paid — the gross pool the partner can draw from. */
  availableGross: number
  /** Already paid out (payouts with status='paid'). */
  paidOut: number
  /** Reserved by open requests (requested/approved/pending/manual_review). */
  inRequest: number
  /** availableGross − paidOut − inRequest. MAY be negative (refund after payout); surface to admin, clamp for the gate. */
  readyToWithdraw: number
}

/**
 * Compute a partner's two-stage balance.
 * @param enrollments the worker's enrollments
 * @param paymentFor  resolver: enrollment → its linked payment (or null)
 * @param payouts     the worker's td_comm payouts
 */
export function computePartnerBalance(
  enrollments: RevenueEnrollment[],
  paymentFor: (e: RevenueEnrollment) => LinkedPayment | null | undefined,
  payouts: TdCommPayout[],
): PartnerBalance {
  let earnedWaiting = 0
  let availableGross = 0
  for (const e of enrollments) {
    if (!isRecognized(e)) continue
    const amount = earningAmount(e)
    if (clientHasPaid(e, paymentFor(e))) availableGross += amount
    else earnedWaiting += amount
  }

  let paidOut = 0
  let inRequest = 0
  for (const p of payouts) {
    if (!reservesBalance(p.status)) continue
    const amount = toAmount(p.amount)
    if (p.status === 'paid') paidOut += amount
    else inRequest += amount
  }

  return {
    earnedWaiting,
    availableGross,
    paidOut,
    inRequest,
    readyToWithdraw: availableGross - paidOut - inRequest,
  }
}

/** Can the partner request a payout of `amount`? (Gate clamps a negative balance to 0.) */
export function canRequestPayout(amount: number, balance: PartnerBalance): boolean {
  if (!Number.isFinite(amount) || amount <= 0) return false
  return amount <= Math.max(0, balance.readyToWithdraw)
}

/* -------------------------------------------------------------------------- */
/* Payout state machine (reused referral_payouts route + new reject)           */
/* -------------------------------------------------------------------------- */

/** Is `to` a legal next status from `from`? Mirrors the partner-actions route + reject. */
export function isValidPayoutTransition(from: string | null, to: PayoutStatus): boolean {
  switch (to) {
    case 'approved':
      return from === 'requested' || from === 'pending' || from === 'manual_review'
    case 'paid':
      return from === 'approved'
    case 'rejected':
      return (
        from === 'requested' || from === 'pending' || from === 'manual_review' || from === 'approved'
      )
    default:
      return false
  }
}

/* -------------------------------------------------------------------------- */
/* Client-payment status (CRM receivable display)                              */
/* -------------------------------------------------------------------------- */

export type ClientPaidState = 'unbilled' | 'unpaid' | 'partial' | 'paid'

/** Coarse client-payment state for the CRM per-project row. */
export function clientPaidState(payment?: LinkedPayment | null): ClientPaidState {
  if (payment == null) return 'unbilled'
  if (payment.status === PAYMENT_PAID_STATUS) return 'paid'
  return 'unpaid'
}

/* -------------------------------------------------------------------------- */
/* Display                                                                     */
/* -------------------------------------------------------------------------- */

/** Format a USD amount as e.g. "$1,250.00". */
export function formatUsd(v: number | string | null | undefined): string {
  const n = toAmount(v)
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

/* -------------------------------------------------------------------------- */
/* Shared output shapes (client-safe — used by the query layer AND the UI)     */
/* -------------------------------------------------------------------------- */

/** A TD-Communication payout row for display (referral_payouts, payout_type='td_comm'). */
export interface TdCommPayoutRow {
  id: string
  partner_id: string | null
  amount: number
  currency: string
  status: string | null
  payout_method: string | null
  reference: string | null
  requested_at: string | null
  approved_at: string | null
  paid_at: string | null
  note: string | null
  created_at: string | null
}

/** A project row for the CRM Revenue tab (admin — includes client price). */
export interface RevenueProjectRow {
  id: string
  subjectName: string
  subjectType: EnrollmentSubjectType
  package_slug: string | null
  packageLabel: string
  status: EnrollmentStatus
  partner_amount_usd: number | null
  recognized: boolean
  available: boolean
  client_payment_id: string | null
  clientPaidState: ClientPaidState
  clientInvoiceTotal: number | null
  client_paid_override_at: string | null
  worker_partner_id: string | null
}

export interface RevenueTotals {
  clientCollected: number
  clientOutstanding: number
  partnerEarnedWaiting: number
  partnerAvailableGross: number
  partnerPaidOut: number
  partnerInRequest: number
  partnerReadyToWithdraw: number
  pendingRequests: number
}

export interface RevenueDashboard {
  projects: RevenueProjectRow[]
  payouts: TdCommPayoutRow[]
  partnerNames: Record<string, string>
  totals: RevenueTotals
}

/** A project row for the partner Earnings view — NO client price / payment amounts. */
export interface PartnerEarningRow {
  id: string
  packageLabel: string
  status: EnrollmentStatus
  amount: number
  recognized: boolean
  clientPaid: boolean
  available: boolean
}

export interface PartnerEarnings {
  balance: PartnerBalance
  projects: PartnerEarningRow[]
  payouts: TdCommPayoutRow[]
}
