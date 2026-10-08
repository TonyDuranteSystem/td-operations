/**
 * Per-row action availability for the client portal Fatture (Invoices) list.
 *
 * Single source of truth for WHICH actions a sales invoice row may offer,
 * gated by its current status. Kept as a pure function so the rules are
 * unit-testable and the row-actions component stays declarative.
 *
 * The client portal invoice tool follows the standard invoice lifecycle
 * (like QuickBooks/Stripe): Draft → (send) → Sent/Overdue → (pay) → Paid.
 * These invoices are the CLIENT's own tool — they never touch TD's books or
 * any tax record — so the client has full control to edit or void their own
 * invoices at any stage, paid or not.
 *
 * Rules (verified against the backend, 2026-06-26):
 *   • edit   — any status except Split (structural parent) and Cancelled (voided).
 *              The edit page mirrors this guard.
 *   • send   — Draft only ("send a draft"). The /send route only advances
 *              Draft → Sent; it never downgrades a paid/sent invoice.
 *   • remind — Sent or Overdue only. A payment reminder on a paid invoice is
 *              meaningless; /remind returns 400 outside Sent/Overdue.
 *   • void   — any status except Split (structural) and Cancelled (already voided).
 */

import { invoiceStatusRule } from './invoice-status'

export type InvoiceRowAction = 'edit' | 'send' | 'remind' | 'void'

// The per-status rules live in ONE table (lib/portal/invoice-status.ts); this only turns them into
// the list of row actions, in the order the row shows them.
export function availableInvoiceActions(status: string | null | undefined): InvoiceRowAction[] {
  const rule = invoiceStatusRule(status)
  if (!rule) return []
  const actions: InvoiceRowAction[] = []
  if (rule.editable) actions.push('edit')
  if (rule.sendable) actions.push('send')
  if (rule.remindable) actions.push('remind')
  if (rule.voidable) actions.push('void')
  return actions
}
