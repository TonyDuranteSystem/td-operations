/**
 * Invoice regeneration — pure helpers
 *
 * "Regenerate" rebuilds an invoice's line-item document so a credit that was
 * applied AFTER the invoice was created (via reconcileAccountCredits, which only
 * adjusts amount_due) is shown explicitly as a line: the full service line(s)
 * plus a "credit applied −$X" line, netting to the amount owed. This mirrors the
 * at-creation netting style of createTDInvoice (keep the service amount visible,
 * subtract the credit as its own line). Generic — works for ANY invoice/service,
 * not just installments.
 *
 * These functions are pure (no I/O) so the math is unit-tested in isolation; the
 * server action wires them to the DB.
 */

export interface RebuildLineItem {
  description: string
  quantity: number
  unit_price: number
  amount: number
}

/** Label used for the credit line a regenerate adds. */
export const CREDIT_LINE_LABEL = "Credit applied"

/** True if a line item is a credit line (negative, or our credit label). */
export function isCreditLine(item: { description?: string | null; amount?: number | null }): boolean {
  const amt = Number(item.amount) || 0
  if (amt < 0) return true
  const d = (item.description || "").toLowerCase()
  return d.includes("credit applied") || d.includes("credit (") || d === "credit"
}

/**
 * The credit that should be shown on THIS invoice = the reduction not already
 * represented as a line (gross − amountDue), but never more than the credit
 * notes actually linked to this invoice (so a real partial payment is never
 * mistaken for a credit), and never negative or above gross.
 */
export function computeAppliedCredit(params: {
  gross: number
  amountDue: number
  linkedCreditTotal: number
}): number {
  const gross = Number(params.gross) || 0
  const amountDue = Math.max(Number(params.amountDue) || 0, 0)
  const linked = Math.max(Number(params.linkedCreditTotal) || 0, 0)
  const reduction = Math.round((gross - amountDue) * 100) / 100
  const capped = Math.min(reduction, linked, gross)
  return capped > 0 ? Math.round(capped * 100) / 100 : 0
}

/**
 * Click-to-apply model (2026-06-03): when staff click Regenerate on an invoice,
 * apply the account's AVAILABLE credit to THIS invoice, on top of any credit it
 * already shows. Pure math — the caller supplies the numbers, persists the row,
 * and consumes the credits. Credits are no longer auto-applied at creation; the
 * invoice the user clicks is the invoice the credit lands on.
 *
 * - gross          = sum of the real service lines (credit lines excluded)
 * - cashPaid       = real cash already paid on the invoice (NOT credit)
 * - existingCredit = credit already shown on this invoice as a line (absolute)
 * - available      = total credit_remaining available on the account (same currency)
 *
 * Applies no more than what is still owed (gross − cashPaid − existingCredit),
 * never negative. Returns the NEW credit to consume now plus the resulting totals.
 */
export interface ClickToApplyResult {
  newApply: number // credit to consume from available now
  totalCredit: number // total credit line to show (existing + new)
  newTotal: number // gross − totalCredit
  newDue: number // max(newTotal − cashPaid, 0)
  settled: boolean
}

export function computeClickToApplyCredit(params: {
  gross: number
  cashPaid: number
  existingCredit: number
  available: number
}): ClickToApplyResult {
  const gross = Math.max(Number(params.gross) || 0, 0)
  const cashPaid = Math.max(Number(params.cashPaid) || 0, 0)
  const existingCredit = Math.max(Number(params.existingCredit) || 0, 0)
  const available = Math.max(Number(params.available) || 0, 0)
  const headroom = Math.max(Math.round((gross - cashPaid - existingCredit) * 100) / 100, 0)
  const newApply = Math.round(Math.min(available, headroom) * 100) / 100
  const totalCredit = Math.round((existingCredit + newApply) * 100) / 100
  const newTotal = Math.round((gross - totalCredit) * 100) / 100
  const newDue = Math.max(Math.round((newTotal - cashPaid) * 100) / 100, 0)
  return { newApply, totalCredit, newTotal, newDue, settled: newDue <= 0 }
}

/**
 * Rebuild the line items: drop any existing credit line(s), keep the real
 * service lines in order, and append a single "Credit applied −$X" line when
 * appliedCredit > 0. Idempotent — re-running with the same inputs yields the
 * same result (the old credit line is stripped first). Returns the service
 * lines unchanged when there is no credit to apply (a no-op rebuild).
 */
export function buildRegeneratedLineItems(
  items: RebuildLineItem[],
  appliedCredit: number,
  creditLabel: string = CREDIT_LINE_LABEL,
): RebuildLineItem[] {
  const service = (items ?? []).filter((i) => !isCreditLine(i))
  const credit = Math.round((Number(appliedCredit) || 0) * 100) / 100
  const out = service.map((i) => ({
    description: i.description,
    quantity: Number(i.quantity) || 1,
    unit_price: i.unit_price,
    amount: i.amount,
  }))
  if (credit > 0) {
    out.push({
      description: creditLabel,
      quantity: 1,
      unit_price: -credit,
      amount: -credit,
    })
  }
  return out
}

/** Sum of line-item amounts (the invoice total after rebuild). */
export function sumLineAmounts(items: RebuildLineItem[]): number {
  return Math.round((items ?? []).reduce((s, i) => s + (Number(i.amount) || 0), 0) * 100) / 100
}
