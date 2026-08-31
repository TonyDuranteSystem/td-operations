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
 * (Draft/Sent/Partial/...), which the ENUM does not carry. A full 9-reviewer
 * pass (2026-08-31) confirmed this boundary is harmless against every real
 * production invoiced row today (zero disagreements found) — the deferral is
 * justified by evidence, not just asserted.
 *
 * "Settled" is delegated to lib/finance/invoice-matchability.ts::isTerminalInvoice
 * (2026-08-31 fix) — NOT a private status set. That module is this codebase's
 * one existing answer to "is anything still owed", built after four divergent
 * terminal-status sets caused a real double-credit incident; this file's own
 * first cut was on track to become a fifth. It correctly treats Refunded/
 * Waived/Credit as settled via the `status` column too, which a plain
 * `invoice_status`-only set cannot.
 */
import { isTerminalInvoice } from "@/lib/finance/invoice-matchability"

export interface InvoiceStatusRow {
  invoice_status: string | null
  status: string | null
  due_date: string | null
}

export function invoiceStatusOf(row: InvoiceStatusRow): string {
  return row.invoice_status ?? row.status ?? ""
}

/**
 * A Sent invoice past its due date is overdue even though its own status
 * string never changes to "Overdue" until the nightly dunning pass runs.
 * A Partial invoice past due is overdue too (2026-08-31 fix, bug-hunter
 * finding) — a partially-paid invoice was, by definition, sent, and a
 * partly-paid balance sitting past due is exactly what "overdue" means; the
 * first cut of this function only recognized Sent, so a partially-paid,
 * months-late invoice showed "0 overdue" everywhere.
 */
export function isInvoiceOverdue(row: InvoiceStatusRow, today: string): boolean {
  const s = invoiceStatusOf(row)
  if (s === "Overdue") return true
  if ((s === "Sent" || s === "Partial") && !!row.due_date && row.due_date < today) return true
  return false
}

export function isInvoiceSettled(row: InvoiceStatusRow): boolean {
  return isTerminalInvoice(row)
}
