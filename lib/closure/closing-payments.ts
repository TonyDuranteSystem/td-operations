/**
 * Company Closure — which of a closing company's open invoice rows the closing step may cancel (bug-hunt over the live closure flow,
 * 2026-11-08, dev job eaa4747e — each case below was reproduced on the sandbox before this was written).
 *
 * Closing cancels the company's UNPAID invoices the way Finance's "Void" does. Three kinds of row look "open" (status Pending / Overdue) but
 * are NOT unpaid invoices, and treating them as such was wrong in a way staff could see:
 *   - a PART-PAID invoice (money already received): cancelling it left the received money recorded against a cancelled invoice with no
 *     word to staff — Finance's Void refuses it for the same reason (`canVoid: paid === 0`). It is left open and reported instead;
 *   - a CREDIT NOTE (an unused client credit, a negative amount, e.g. from a paid strategy call): not an invoice, never cancelled — but the
 *     question counted it as "1 unpaid invoice" and summed its amount;
 *   - a row whose status column is stale (its invoice status already says Paid / Cancelled / Voided): nothing to do.
 *
 * Pure — no database. Used by the question (`readClosingBrief`) and by the step itself (`applyCompanyClosure`) so they can never disagree.
 */

export interface OpenPaymentRow {
  id: string
  invoice_number: string | null
  status: string | null
  invoice_status: string | null
  amount: number | string | null
  amount_currency: string | null
  amount_due: number | string | null
  amount_paid: number | string | null
}

export interface ClassifiedPayments<T extends OpenPaymentRow> {
  /** unpaid invoices — safe to cancel */
  cancel: T[]
  /** invoices with money already received — NOT cancelled, reported to staff */
  partPaid: T[]
  /** unused credit notes — NOT cancelled (not invoices) */
  credits: T[]
}

const SETTLED = new Set(['paid', 'cancelled', 'voided'])

function num(v: number | string | null | undefined): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

export function classifyOpenPayments<T extends OpenPaymentRow>(rows: readonly T[]): ClassifiedPayments<T> {
  const out: ClassifiedPayments<T> = { cancel: [], partPaid: [], credits: [] }
  for (const r of rows) {
    const inv = (r.invoice_status ?? '').toLowerCase()
    if (inv === 'credit' || num(r.amount) < 0) { out.credits.push(r); continue }
    if (SETTLED.has(inv)) continue // the status column is stale — nothing is owed and nothing to cancel
    if (num(r.amount_paid) > 0) { out.partPaid.push(r); continue }
    out.cancel.push(r)
  }
  return out
}

/** What is still owed on the row: the due amount when the row carries one, else the full amount. */
export function owedOf(r: Pick<OpenPaymentRow, 'amount' | 'amount_due'>): number {
  return r.amount_due !== null && r.amount_due !== undefined ? num(r.amount_due) : num(r.amount)
}

export function paidOf(r: Pick<OpenPaymentRow, 'amount_paid'>): number {
  return num(r.amount_paid)
}

/** Sum by currency, rounded to cents. `pick` chooses the amount per row (owed, absolute credit, …). */
export function totalsByCurrency<T extends { amount_currency: string | null }>(rows: readonly T[], pick: (r: T) => number): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const r of rows) {
    const cur = (r.amount_currency || 'USD').toUpperCase()
    totals[cur] = Math.round(((totals[cur] ?? 0) + pick(r)) * 100) / 100
  }
  return totals
}
