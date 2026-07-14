/**
 * Invoice money math — pure, unit-tested, no I/O.
 *
 * Extracted from `lib/bank-feed-matcher.ts` (2026-07-14) so the single money
 * writer (`lib/finance/apply-payment.ts`) can use it without importing the
 * matcher, which would be circular. The matcher re-exports it, so existing
 * imports keep working.
 */

/**
 * Calculate the new invoice status and running totals after a payment is applied.
 *
 * ACCUMULATES (currentAmountPaid + feedAmount) — a second, genuine part-payment
 * adds to the first rather than replacing it. The auto-matcher used to OVERWRITE,
 * which silently erased earlier partial payments.
 *
 * CAPS amount_paid at the invoice total — an invoice can never record MORE paid
 * than it's worth. A wire larger than the balance (e.g. $650 matched to a $500
 * invoice) marks it Paid for exactly $500; the surplus is NOT applied here. The
 * true received amount still lives on the bank feed (feed.amount), so the
 * overpayment stays visible as feed > invoice-paid — nothing is lost.
 */
export function resolveInvoiceStatusAfterPayment(
  invoiceTotal: number,
  currentAmountPaid: number,
  feedAmount: number,
): { newStatus: "Paid" | "Partial"; newAmountPaid: number; newAmountDue: number } {
  const newAmountPaid = Math.min(currentAmountPaid + feedAmount, invoiceTotal)
  const newAmountDue = Math.max(invoiceTotal - newAmountPaid, 0)
  const newStatus = newAmountDue <= 0 ? "Paid" : "Partial"
  return { newStatus, newAmountPaid, newAmountDue }
}
