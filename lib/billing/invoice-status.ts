/**
 * Shared "is this invoiced row overdue / settled" classification for the
 * account Payments tab, the contact Invoices tab, and the account/contact
 * Finance summary card (dev job 10995181, council review 2026-08-30). Before
 * this file existed, all three had their own independently-typed copy of the
 * same rule, and two of them had already drifted from each other on the
 * SAME screen (a Sent-and-past-due invoice read "overdue" on one and
 * "pending" on the other). One shared rule, three call sites — extend here,
 * not per-surface.
 *
 * Deliberately NOT unified with lib/billing/overdue.ts, which powers the
 * Portal Chats badges: that module reads `payments.status` (the coarse
 * ENUM — Pending/Overdue/Delinquent/...) because it must also cover rows
 * that were never formally invoiced at all. These three surfaces only ever
 * look at real invoiced rows and need the richer `invoice_status` vocabulary
 * (Draft/Sent/Partial/...), which the ENUM does not carry. Merging the two
 * would mean rewiring a live, already-correct production badge for a
 * consolidation this pass has no concrete evidence it needs — flagged as a
 * known, bounded gap, not silently ignored.
 */

export interface InvoiceStatusRow {
  invoice_status: string | null
  status: string | null
  due_date: string | null
}

/** Statuses that mean "nothing left to collect" — a Split parent (its child
 *  installments carry the real balances) counts as settled here too. */
export const SETTLED_INVOICE_STATUSES = new Set(["Paid", "Cancelled", "Voided", "Split"])

export function invoiceStatusOf(row: InvoiceStatusRow): string {
  return row.invoice_status ?? row.status ?? ""
}

/** A Sent invoice past its due date is overdue even though its own status
 *  string never changes to "Overdue" until the nightly dunning pass runs. */
export function isInvoiceOverdue(row: InvoiceStatusRow, today: string): boolean {
  const s = invoiceStatusOf(row)
  return s === "Overdue" || (s === "Sent" && !!row.due_date && row.due_date < today)
}

export function isInvoiceSettled(row: InvoiceStatusRow): boolean {
  return SETTLED_INVOICE_STATUSES.has(invoiceStatusOf(row))
}
