/**
 * Which invoice(s) is a company's installment N for a year, and what small chip describes them?
 *
 * ONE definition shared by the Account page's "Annual Installments" badge and the Paid / Pending / Overdue chip on the
 * Accounts and Contacts lists, so the three screens can never disagree. Identity is the structured
 * (account + payment_category + year) stamp via `isInstallment` — never an amount or description text (that is how the
 * ShoppyVerse duplicate went unnoticed).
 *
 * Pure and client-safe: no database access, no clock.
 */

import { isInstallment, type ClassifiablePayment } from '@/lib/billing/payment-classification'

/** The columns a caller must select to classify an installment invoice. */
export interface InstallmentPaymentRow extends ClassifiablePayment {
  total: number | string | null
  invoice_number: string | null
}

/**
 * Every REAL live invoice for installment `n` of `year` (a list, not one row: a duplicate must be visible, not hidden by
 * silently picking the first).
 *
 * "Real" excludes a $0 / no-invoice-number row on top of `isInstallment`'s own live check. The $0 exclusion is a different
 * concern `isInstallment` must NOT absorb: production has a legitimate pattern (consolidated first-installment billing) of
 * a $0 companion record on the non-billed account so cron eligibility still sees "installment paid" — it is not a second
 * REAL invoice and must never trigger the duplicate warning.
 */
export function findInstallmentInvoice<T extends InstallmentPaymentRow>(payments: T[], n: 1 | 2, year: number): T[] {
  return payments.filter(
    (p) =>
      isInstallment(p, n, { year }) &&
      (Number(p.total) || 0) > 0 &&
      !!p.invoice_number &&
      p.invoice_number !== '1.0' &&
      p.invoice_number !== '2.0',
  )
}

export type InstallmentChipKind = 'paid' | 'pending' | 'overdue' | 'waived' | 'refunded' | 'not_invoiced' | 'duplicate'

export interface InstallmentChip {
  kind: InstallmentChipKind
  /** How many real invoices matched (only meaningful for `duplicate`). */
  count: number
}

/** The words on the chip. */
export const INSTALLMENT_CHIP_LABEL: Record<InstallmentChipKind, string> = {
  paid: 'Paid',
  pending: 'Pending',
  overdue: 'Overdue',
  waived: 'Waived',
  refunded: 'Refunded',
  not_invoiced: 'Not invoiced',
  duplicate: 'Duplicate',
}

/**
 * The chip for one installment of one year, from the matches `findInstallmentInvoice` returned. Status is read the same way
 * the Account page badge reads it: the invoice status first, then the payment status.
 */
export function installmentChip(matches: InstallmentPaymentRow[]): InstallmentChip {
  if (matches.length === 0) return { kind: 'not_invoiced', count: 0 }
  if (matches.length > 1) return { kind: 'duplicate', count: matches.length }
  const m = matches[0] as InstallmentPaymentRow & { invoice_status?: string | null; status?: string | null }
  const status = m.invoice_status ?? m.status ?? ''
  switch (status) {
    case 'Paid':
      return { kind: 'paid', count: 1 }
    case 'Overdue':
    case 'Delinquent':
      return { kind: 'overdue', count: 1 }
    case 'Waived':
      return { kind: 'waived', count: 1 }
    case 'Refunded':
      return { kind: 'refunded', count: 1 }
    default:
      return { kind: 'pending', count: 1 }
  }
}

/** Convenience: the chip for installment `n` of `year` straight from a company's payments. */
export function chipForInstallment(payments: InstallmentPaymentRow[], n: 1 | 2, year: number): InstallmentChip {
  return installmentChip(findInstallmentInvoice(payments, n, year))
}
