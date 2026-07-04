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
