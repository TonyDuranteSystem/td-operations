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

export type InvoiceRowAction = 'edit' | 'send' | 'remind' | 'void'

// Editing/voiding a Split parent would break its installment children; an
// already-Cancelled invoice has nothing left to edit or void.
const EDITABLE = ['Draft', 'Sent', 'Overdue', 'Paid', 'Partial']
const VOIDABLE = ['Draft', 'Sent', 'Overdue', 'Paid', 'Partial']

export function availableInvoiceActions(status: string | null | undefined): InvoiceRowAction[] {
  const s = (status ?? '').trim()
  const actions: InvoiceRowAction[] = []

  if (EDITABLE.includes(s)) {
    actions.push('edit')
  }
  if (s === 'Draft') {
    actions.push('send')
  }
  if (s === 'Sent' || s === 'Overdue') {
    actions.push('remind')
  }
  if (VOIDABLE.includes(s)) {
    actions.push('void')
  }

  return actions
}
