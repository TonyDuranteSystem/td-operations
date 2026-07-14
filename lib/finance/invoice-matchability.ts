/**
 * Invoice matchability — the ONE definition of "can incoming money still be
 * applied to this invoice?".
 *
 * Why this module exists (2026-07-14, Simple Holdings / Fazekas incident):
 * the system had FOUR divergent terminal-status sets — the matcher
 * (`Paid|Voided|Cancelled`), the multi-match partitioner (+`Credit`), the
 * Finance server query (+`Split`, but NOT `Paid`), and `settleInvoiceFromFeed`
 * (`Paid|Voided|Credit`, missing `Cancelled`). Each one let a different class of
 * already-closed invoice back into the pool.
 *
 * Two columns, not one. `payments` carries BOTH `invoice_status` (text, the
 * document lifecycle: Draft → Sent → Overdue → Partial → Paid) and `status`
 * (the payment_status enum: Pending / Paid / Overdue / Delinquent / Waived /
 * Refunded / Not Invoiced / Cancelled). They disagree in production — 48 rows
 * are `status='Paid'` with a NULL `invoice_status`, and reading `invoice_status`
 * alone let those already-paid invoices be auto-matched a SECOND time.
 *
 * Reading `invoice_status` alone is unsafe; excluding NULL `invoice_status`
 * outright is ALSO unsafe — payment `50428dcc` ($1,250 "First Installment 2026",
 * `status='Overdue'`, no invoice_status, no invoice_number) is a genuine open
 * receivable and must stay matchable. So: an invoice is terminal if EITHER
 * column says it is closed; a NULL `invoice_status` falls back to `status`.
 *
 * Deliberately still matchable:
 *  - `Draft`   — invoice created at contract signing; payment legitimately
 *                arrives before the invoice is formally sent.
 *  - `Partial` — the remaining balance is still owed.
 *  - `Pending` / `Overdue` / `Delinquent` — money still expected.
 */

/** `invoice_status` values that mean the document is closed. */
export const TERMINAL_INVOICE_STATUSES = new Set([
  "Paid",
  "Voided",
  "Cancelled",
  "Credit",
  "Split",
])

/**
 * `status` (payment_status enum) values that mean no further money is expected.
 * `Refunded` is terminal: the money went back to the client, so a new deposit
 * must never silently re-apply to it. `Not Invoiced` is terminal for MATCHING:
 * there is no invoice to settle yet (these are placeholder installment rows).
 */
export const TERMINAL_PAYMENT_STATUSES = new Set([
  "Paid",
  "Cancelled",
  "Waived",
  "Refunded",
  "Not Invoiced",
])

/** The two status columns every matchability decision reads. */
export interface InvoiceStatusPair {
  invoice_status?: string | null
  status?: string | null
}

/**
 * True when the invoice is closed and MUST NOT receive money — from the
 * auto-matcher, the manual-match UI, or the multi-invoice waterfall.
 *
 * Terminal if EITHER column is terminal. A NULL/blank `invoice_status` is not
 * evidence of anything, so it falls back to `status`.
 */
export function isTerminalInvoice(inv: InvoiceStatusPair): boolean {
  const invoiceStatus = inv.invoice_status?.trim()
  const paymentStatus = inv.status?.trim()

  if (invoiceStatus && TERMINAL_INVOICE_STATUSES.has(invoiceStatus)) return true
  if (paymentStatus && TERMINAL_PAYMENT_STATUSES.has(paymentStatus)) return true

  return false
}

/** True when incoming money can still be applied to this invoice. */
export function isMatchableInvoice(inv: InvoiceStatusPair): boolean {
  return !isTerminalInvoice(inv)
}

/**
 * Why a terminal invoice is closed — for the loud server-side rejection when a
 * human tries to settle one from the bank-feed UI (R099: surface the real
 * reason, never a generic failure).
 */
export function terminalReason(inv: InvoiceStatusPair): string | null {
  const invoiceStatus = inv.invoice_status?.trim()
  const paymentStatus = inv.status?.trim()

  if (invoiceStatus && TERMINAL_INVOICE_STATUSES.has(invoiceStatus)) {
    return `Invoice is already ${invoiceStatus}`
  }
  if (paymentStatus && TERMINAL_PAYMENT_STATUSES.has(paymentStatus)) {
    return `Invoice is already ${paymentStatus}`
  }
  return null
}
