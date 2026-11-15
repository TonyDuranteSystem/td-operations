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

/** The status of a payment row, read one way everywhere: the invoice status first, then the payment status. */
function statusOf(p: object): string {
  const m = p as { invoice_status?: string | null; status?: string | null }
  return m.invoice_status ?? m.status ?? ''
}

/**
 * Statuses that mean "the money side of this installment is settled or has gone past due", so the row counts even when it carries no
 * invoice number. A pending, draft or "Not Invoiced" row with no number is only a placeholder waiting for its invoice, so it does NOT count.
 */
const COUNTS_WITHOUT_INVOICE_NUMBER: ReadonlySet<string> = new Set(['Paid', 'Overdue', 'Delinquent', 'Waived'])

/** A real invoice number: present and not one of the legacy "1.0" / "2.0" placeholders. */
function hasInvoiceNumber(p: InstallmentPaymentRow): boolean {
  return !!p.invoice_number && p.invoice_number !== '1.0' && p.invoice_number !== '2.0'
}

/**
 * Every REAL live record for installment `n` of `year` (a list, not one row: a duplicate must be visible, not hidden by
 * silently picking the first).
 *
 * "Real" excludes a $0 row on top of `isInstallment`'s own live check. The $0 exclusion is a different concern
 * `isInstallment` must NOT absorb: production has a legitimate pattern (consolidated first-installment billing) of
 * a $0 companion record on the non-billed account so cron eligibility still sees "installment paid" — it is not a second
 * REAL invoice and must never trigger the duplicate warning.
 *
 * A record WITH an invoice number always wins. Only when there is none does a record WITHOUT one count, and only when its
 * status says the money is settled or past due (Paid / Overdue / Waived). Those are the March–April 2026 imports and any
 * payment marked Paid by hand: the money is recorded, so the chip must say so instead of "Not invoiced" (Antonio, 2026-11-15).
 * Numbered-first means a company can never be flagged as a duplicate just because an old unnumbered record sits next to its invoice.
 */
export function findInstallmentInvoice<T extends InstallmentPaymentRow>(payments: T[], n: 1 | 2, year: number): T[] {
  const live = payments.filter((p) => isInstallment(p, n, { year }) && (Number(p.total) || 0) > 0)
  const numbered = live.filter(hasInvoiceNumber)
  if (numbered.length > 0) return numbered
  return live.filter((p) => COUNTS_WITHOUT_INVOICE_NUMBER.has(statusOf(p)))
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
  const status = statusOf(matches[0])
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
