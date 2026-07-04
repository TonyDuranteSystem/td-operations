/**
 * Client-portal visibility for TD invoice rows (`payments`).
 *
 * An UNSENT DRAFT — created by staff or the annual-installments cron but not
 * yet reviewed and sent — must not appear in the client's portal payment
 * history (Antonio's decision, 2026-07-04, after the Kasabi Ocean Global
 * incident: the client saw a "Pending $1,000" invoice nobody had sent).
 *
 * Exactly `invoice_status='Draft' AND status='Pending'` identifies an unsent
 * draft: createTDInvoice marks fully-paid / credit-covered invoices
 * invoice_status='Paid' at creation (never Draft), so a Draft that was paid
 * anyway (status='Paid') stays visible as real history, and legacy rows with
 * invoice_status=NULL are untouched.
 */
export function isClientVisiblePayment(p: {
  invoice_status?: string | null
  status?: string | null
}): boolean {
  return !(p.invoice_status === 'Draft' && p.status === 'Pending')
}

/**
 * Same rule applied to the client's Expenses tab: `createTDInvoice` writes a
 * `client_expenses` mirror row AT DRAFT TIME, so an unsent draft would still
 * show to the client as a "Tony Durante LLC — Pending" expense even though
 * Payment History hides it. Filter out a TD-invoice mirror whose linked
 * payment is an unsent draft.
 *
 * Fail-open on data drift: a mirror whose payment row is missing from the
 * lookup stays visible — hiding real client expenses is worse than showing a
 * stale mirror. Non-TD rows (uploads, manual expenses) are never touched.
 */
export function filterClientVisibleExpenseMirrors<
  T extends { source?: string | null; td_payment_id?: string | null },
>(
  expenses: T[],
  linkedPayments: Array<{ id: string; invoice_status?: string | null; status?: string | null }>,
): T[] {
  const hidden = new Set(
    linkedPayments.filter(p => !isClientVisiblePayment(p)).map(p => p.id),
  )
  if (hidden.size === 0) return expenses
  return expenses.filter(
    e => !(e.source === 'td_invoice' && e.td_payment_id && hidden.has(e.td_payment_id)),
  )
}
