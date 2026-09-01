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
  /** Optional — when present and exactly 0, backs the display-only settled
   *  check below. Not part of isTerminalInvoice's own contract (money-
   *  matching/reconciliation callers don't pass it), so omitting it is
   *  always safe and never changes behavior for those callers. */
  amount_due?: number | null
}

export function invoiceStatusOf(row: InvoiceStatusRow): string {
  return row.invoice_status ?? row.status ?? ""
}

export interface CreditNoteRow {
  invoice_number?: string | null
  invoice_status?: string | null
  status?: string | null
  total?: number | null
}

/**
 * A credit note is money TD owes the client, never a receivable. Checked by
 * number prefix (assigned at creation, before any status transition) rather
 * than solely by invoice_status='Credit' (assigned in a separate, sometimes
 * delayed, follow-up step) so a not-yet-retagged credit note is still
 * excluded — a credit tied to a split/installment-plan invoice is not
 * necessarily issued right away (Antonio, 2026-08-30), so it can sit briefly
 * at invoice_status='Draft' before being retagged.
 *
 * Moved here 2026-08-31 (QA-Tester finding, third council review) — this was
 * a private function inside finance-summary.ts, so the Finance card excluded
 * credit notes but the account Payments tab and contact Invoices tab never
 * did, letting a credit note's negative total distort those two tabs' totals
 * while the Finance card on the SAME page correctly showed nothing there.
 * One shared rule, three call sites — same principle as isInvoiceOverdue/
 * isInvoiceSettled above.
 */
export function isCreditNote(row: CreditNoteRow): boolean {
  const invoiceStatus = row.invoice_status ?? row.status ?? ""
  return !!row.invoice_number?.startsWith("CN-") || invoiceStatus === "Credit" || Number(row.total) < 0
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

/**
 * Display-only backstop on top of isTerminalInvoice (2026-08-31,
 * Finance-Auditor finding, third council review): a row can carry
 * `invoice_status: "Partial"` (open per rule 3 of isTerminalInvoice — by
 * design, since an open invoice_status legitimately outranks a stale
 * administrative `status`, per the Fiscalot case that module's header
 * documents) while its OWN tracked remaining balance (`amount_due`) has
 * already reached exactly 0 because `status` was simply never flipped to
 * Paid. isTerminalInvoice has no way to know this — it never reads
 * `amount_due` at all, and deliberately doesn't, since money-matching
 * callers use a different signal. This check is ADDITIVE ONLY (an `||`,
 * never subtracts a case isTerminalInvoice already returns true for) and
 * scoped to display classification alone — it is not wired into
 * isTerminalInvoice itself, so the bank-feed matcher, dedup, and every
 * other real money-matching caller of that module are completely
 * unaffected by this file.
 */
export function isInvoiceSettled(row: InvoiceStatusRow): boolean {
  if (isTerminalInvoice(row)) return true
  return row.amount_due === 0
}
