/**
 * TD invoice → client_expenses mirror sync (leaf module).
 *
 * `payments` is the SINGLE SOURCE OF TRUTH for TD invoices; `client_expenses`
 * (source='td_invoice') is a client-facing PROJECTION of it. This module holds
 * the one authoritative function that rebuilds that projection, so the two
 * copies can never silently drift.
 *
 * Kept in its own leaf module (deps: db + supabase-admin only) so BOTH
 * `td-invoice.ts` and `credit-netting.ts` can import it without a circular
 * import (td-invoice ↔ credit-netting).
 */
import { supabaseAdmin } from '@/lib/supabase-admin'

/**
 * Map a `payments` state (invoice_status, else legacy status) → the portal
 * `client_expenses.status` vocabulary (Pending / Paid / Overdue / Cancelled).
 * A credit note (`Credit`) and a fully-covered invoice both read as Paid.
 * Pure — unit tested.
 */
export function mapPaymentStatusToExpense(paymentInvoiceStatus: string | null | undefined): string {
  const s = paymentInvoiceStatus || 'Pending'
  const map: Record<string, string> = {
    Draft: 'Pending', Sent: 'Pending', Pending: 'Pending', Partial: 'Pending',
    Overdue: 'Overdue',
    Paid: 'Paid', Credit: 'Paid',
    Cancelled: 'Cancelled', Split: 'Cancelled', Voided: 'Cancelled',
  }
  return map[s] || s
}

/** Pure diff: does the projected state differ from the current mirror row? */
export function mirrorDiffers(
  before: { total: number | null; amount_due: number | null; amount_paid: number | null; status: string | null; paid_date: string | null },
  after: { total: number; amount_due: number; amount_paid: number; status: string; paid_date: string | null },
): boolean {
  return (
    Number(before.total) !== after.total ||
    Number(before.amount_due) !== after.amount_due ||
    Number(before.amount_paid) !== after.amount_paid ||
    (before.status ?? null) !== after.status ||
    (before.paid_date ?? null) !== after.paid_date
  )
}

/**
 * AUTHORITATIVE mirror projection. Rebuilds the `client_expenses` mirror row's
 * full financial state (total, amount_due, amount_paid, status, paid_date) from
 * the `payments` row. Idempotent.
 *
 * Call it after ANY change to a TD invoice's amounts/status (credit application,
 * edits, status transitions) so the client-facing copy can never silently drift.
 * The old scattered per-site partial updates (which wrote only some columns)
 * caused the drift this fixes (Giuseppe INV-002233: credit reduced the payment
 * to $700 but the mirror stayed at $1,150).
 *
 * Does NOT emit the payment-received portal event — that stays in
 * `syncTDInvoiceStatus`, since a credit settling an invoice is not a cash payment.
 */
export type MirrorSnapshot = Record<string, string | number | null>

/**
 * DIAGNOSTIC ONLY (dev job 0dcb0a18). The database itself now keeps
 * `client_expenses` in sync with `payments` automatically — a trigger on
 * `payments` (migration 20260823-1200) recomputes the matching mirror row
 * inside the same transaction as any write to a TD invoice's money/status/
 * date fields, for every writer, present or future. A second trigger on
 * `client_expenses` refuses any OTHER attempt to write those fields on a
 * `source='td_invoice'` row — including this function's own former write,
 * which is why it no longer performs one.
 *
 * This function now only REPORTS whether the mirror currently matches
 * `payments` (it should always be true, since the DB trigger already did
 * the work) — used by the CRM "Sync Mirror" admin button and the CLI
 * reconciliation sweep as a read-only health check, not a repair tool.
 */
export async function syncTDInvoiceMirror(
  paymentId: string,
): Promise<{ changed: boolean; before?: MirrorSnapshot; after?: MirrorSnapshot }> {
  const db = supabaseAdmin
  const { data: p } = await db
    .from('payments')
    .select('total, amount, amount_due, amount_paid, status, invoice_status, paid_date')
    .eq('id', paymentId)
    .maybeSingle()
  if (!p) return { changed: false }

  const { data: before } = await db
    .from('client_expenses')
    .select('total, amount_due, amount_paid, status, paid_date')
    .eq('td_payment_id', paymentId)
    .maybeSingle()
  if (!before) return { changed: false } // no mirror row (e.g. contact-only or not a TD invoice)

  // Derive the balance from the projected status, don't blind-copy payments'
  // amount_due: some Paid payment rows carry a stale non-zero amount_due, and
  // copying it would show "$2,000" next to a Paid badge. A settled (Paid /
  // Cancelled) invoice owes 0 — matching the DB trigger's own mirror logic.
  const status = mapPaymentStatusToExpense((p.invoice_status as string | null) ?? (p.status as string | null))
  const settled = status === 'Paid' || status === 'Cancelled'
  const after = {
    total: Number(p.total ?? p.amount ?? 0),
    amount_due: settled ? 0 : Number(p.amount_due ?? 0),
    amount_paid: Number(p.amount_paid ?? 0),
    status,
    paid_date: (p.paid_date as string | null) ?? null,
  }

  // No write here — the payments-side trigger already applied it. Reporting
  // `changed: true` now means the trigger has NOT run for this row (e.g. the
  // migration predates this payment, or the trigger itself needs attention),
  // which is exactly the signal the admin button and CLI sweep want to see.
  return { changed: mirrorDiffers(before as never, after), before: before as MirrorSnapshot, after }
}

/**
 * The ONE thing the 20260823 trigger + this module's diagnostic pass do NOT
 * cover: `client_expense_items`, the line-item detail behind a `client_expenses`
 * mirror row. It is written exactly once, at invoice creation
 * (`td-invoice.ts`'s `createTDInvoice`), and nothing anywhere in this codebase
 * has ever updated it since — confirmed by a full-repo audit, 2026-09-01
 * (ShoppyVerse/Growly investigation). Every post-creation edit to
 * `payment_items` (a credit application, a staff total correction) leaves this
 * table showing the ORIGINAL line items forever, even though the header total
 * it sits under is correctly kept in sync by the trigger. Call this any time
 * `payment_items` changes after creation, alongside whatever wrote the new
 * items — it is not automatic.
 *
 * No-op (returns `synced: false`) when the invoice has no `client_expenses`
 * mirror row at all (a contact-only invoice, or one that predates the portal
 * mirror), matching `syncTDInvoiceMirror`'s own no-mirror behavior above.
 */
export async function syncClientExpenseItemsMirror(
  paymentId: string,
  items: Array<{ description: string; quantity: number; unit_price: number; amount: number; sort_order?: number }>,
): Promise<{ synced: boolean }> {
  const db = supabaseAdmin
  const { data: expense } = await db
    .from('client_expenses')
    .select('id')
    .eq('td_payment_id', paymentId)
    .maybeSingle()
  if (!expense) return { synced: false }

  await db.from('client_expense_items').delete().eq('expense_id', expense.id)
  if (items.length > 0) {
    await db.from('client_expense_items').insert(
      items.map((item, i) => ({
        expense_id: expense.id,
        description: item.description,
        quantity: item.quantity,
        unit_price: item.unit_price,
        amount: item.amount,
        sort_order: item.sort_order ?? i,
      })),
    )
  }
  return { synced: true }
}
