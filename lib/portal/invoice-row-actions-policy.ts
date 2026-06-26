/**
 * Per-row action availability for the client portal Fatture (Invoices) list.
 *
 * Single source of truth for WHICH actions a sales invoice row may offer,
 * gated by its current status. Kept as a pure function so the rules are
 * unit-testable and the row-actions component stays declarative.
 *
 * Rules (verified against the existing backend, 2026-06-26):
 *   • edit   — Draft only. Editing a sent invoice would diverge from what the
 *              customer already received.
 *   • send   — Draft only. The send route flips status to 'Sent'; re-sending a
 *              Sent invoice is covered by 'remind'.
 *   • remind — Sent or Overdue. /remind returns 400 for any other status.
 *   • void   — Draft / Sent / Overdue. voidInvoice() throws for Paid / Partial /
 *              Split (a paid invoice is a credit-note/refund case, not a void).
 */

export type InvoiceRowAction = 'edit' | 'send' | 'remind' | 'void'

const VOIDABLE = ['Draft', 'Sent', 'Overdue']

export function availableInvoiceActions(status: string | null | undefined): InvoiceRowAction[] {
  const s = (status ?? '').trim()
  const actions: InvoiceRowAction[] = []

  if (s === 'Draft') {
    actions.push('edit', 'send')
  }
  if (s === 'Sent' || s === 'Overdue') {
    actions.push('remind')
  }
  if (VOIDABLE.includes(s)) {
    actions.push('void')
  }

  return actions
}
