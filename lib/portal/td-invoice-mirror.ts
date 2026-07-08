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
import { dbWriteSafe } from '@/lib/db'

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
 * ALWAYS runs as service-role (`supabaseAdmin`). `client_expenses` has RLS
 * enabled with NO policies, so a staff/user-scoped client (e.g. the one
 * `regenerateInvoice` passes) is silently denied every write — 0 rows, no error.
 * That was the ACTUAL cause of the drift: credit-apply updated `payments` with
 * the staff client (allowed) but its mirror write hit RLS and never landed.
 * This function must never depend on the caller's client for the mirror.
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
  // Cancelled) invoice owes 0 — matching createTDInvoice's own mirror logic.
  const status = mapPaymentStatusToExpense((p.invoice_status as string | null) ?? (p.status as string | null))
  const settled = status === 'Paid' || status === 'Cancelled'
  const after = {
    total: Number(p.total ?? p.amount ?? 0),
    amount_due: settled ? 0 : Number(p.amount_due ?? 0),
    amount_paid: Number(p.amount_paid ?? 0),
    status,
    paid_date: (p.paid_date as string | null) ?? null,
  }

  await dbWriteSafe(
    db
      .from('client_expenses')
      // eslint-disable-next-line no-restricted-syntax -- authoritative mirror projection from payments (source of truth); this IS the sanctioned sync path
      .update({ ...after, updated_at: new Date().toISOString() })
      .eq('td_payment_id', paymentId),
    'client_expenses.update',
  )

  return { changed: mirrorDiffers(before as never, after), before: before as MirrorSnapshot, after }
}
