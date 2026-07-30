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
  // Round to cents. These are money columns with 2 decimal places, but the arithmetic is
  // float: 0.1 + 0.2 is 0.30000000000000004, and without rounding that dust gets written
  // into the invoice. It survives a round-trip (so it is not a correctness bug today),
  // but it poisons the scale-2 property every hand-written SQL comparison relies on.
  // `planWaterfallAllocation` already rounds; the writer must too.
  const round2 = (n: number) => Math.round(n * 100) / 100

  const newAmountPaid = round2(Math.min(currentAmountPaid + feedAmount, invoiceTotal))
  const newAmountDue = round2(Math.max(invoiceTotal - newAmountPaid, 0))
  const newStatus = newAmountDue <= 0 ? "Paid" : "Partial"
  return { newStatus, newAmountPaid, newAmountDue }
}

/**
 * The mirror image: what the invoice looks like after ONE transaction's money is taken back off.
 *
 * ⛔ DO NOT DO THIS WITH `resolveInvoiceStatusAfterPayment` AND A NEGATIVE AMOUNT.
 * That function only ADDS and can only return Paid or Partial. Fed a negative it reports
 * "Partial" for an invoice with nothing paid on it — an incoherent row that the overdue
 * chaser and the client's portal both read as a live part-payment — and its cap
 * (`min(paid, total)`) silently destroys real cash whenever the invoice total was edited
 * downwards after the money arrived.
 *
 * THREE RULES, each earned in review:
 *  1. **Subtract the CREDITED amount, clamped.** The ledger row records what was actually
 *     credited (already capped: a $650 wire against a $500 balance recorded $500), so that is
 *     the figure to remove. Clamping to what is currently paid means a double-click, or a
 *     legacy row written before the cap existed, can never drive the invoice negative — which
 *     would tell the client they owe MORE than the invoice.
 *  2. **The remaining balance decides Paid / Partial / open — never a snapshot.** Residual
 *     money from another rail keeps the invoice Partial; a fully reversed invoice is OPEN, and
 *     the caller supplies which flavour of open (Draft if it was never sent, Sent/Overdue if it
 *     was). Letting a snapshot decide would restore "Sent" onto an invoice still holding $400.
 *  3. **`paid_date` only survives if money still does.** Leaving the reversed transaction's
 *     date on residual cash books that cash in the wrong month — invoice income is dated by
 *     `paid_date` first.
 */
export function resolveInvoiceStatusAfterReversal(
  invoiceTotal: number,
  currentAmountPaid: number,
  creditedAmount: number,
): {
  /** null ⇒ the invoice is OPEN again; the caller decides Draft vs Sent vs Overdue. */
  newStatus: "Paid" | "Partial" | null
  newAmountPaid: number
  newAmountDue: number
  /** false ⇒ clear paid_date; nothing is paid any more. */
  keepPaidDate: boolean
} {
  const round2 = (n: number) => Math.round(n * 100) / 100

  const removable = Math.min(Math.max(creditedAmount, 0), Math.max(currentAmountPaid, 0))
  const newAmountPaid = round2(Math.max(currentAmountPaid - removable, 0))
  const newAmountDue = round2(Math.max(invoiceTotal - newAmountPaid, 0))

  const newStatus =
    newAmountPaid <= 0 ? null : newAmountDue <= 0 ? "Paid" : "Partial"

  return { newStatus, newAmountPaid, newAmountDue, keepPaidDate: newAmountPaid > 0 }
}
