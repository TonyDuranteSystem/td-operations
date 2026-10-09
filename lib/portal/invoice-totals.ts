/**
 * Totals on the Sales / Expenses tabs (dev job 1a23f5f1, council review 2026-10-09).
 *
 * The page used to add euros and dollars together and print the result with a "$", counted Drafts and the
 * parent of a split invoice as "outstanding", counted a part-paid invoice's whole total as unpaid, and only looked
 * at the 100 newest invoices. These helpers fix the arithmetic; the page decides what to show.
 */

export type MoneyByCurrency = Record<string, number>

export interface TotalsRow {
  status: string | null
  currency: string | null
  total: number | string | null
  amount_paid?: number | string | null
  amount_due?: number | string | null
}

const round2 = (n: number) => Math.round(n * 100) / 100
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

/** Statuses that mean "billed to the customer and still waiting for money". */
export const OPEN_STATUSES = ['Sent', 'Overdue', 'Partial']
/** Statuses that count as billed at all (a Draft was never sent; Cancelled/Split are not real receivables). */
export const BILLED_STATUSES = ['Sent', 'Overdue', 'Partial', 'Paid']

function add(map: MoneyByCurrency, currency: string | null, amount: number) {
  const c = currency === 'EUR' ? 'EUR' : 'USD'
  map[c] = round2((map[c] ?? 0) + amount)
}

export function salesTotals(rows: TotalsRow[]): { invoiced: MoneyByCurrency; paid: MoneyByCurrency; outstanding: MoneyByCurrency } {
  const invoiced: MoneyByCurrency = {}
  const paid: MoneyByCurrency = {}
  const outstanding: MoneyByCurrency = {}
  for (const r of rows) {
    const status = r.status ?? ''
    if (!BILLED_STATUSES.includes(status)) continue
    const total = num(r.total)
    const alreadyPaid = status === 'Paid' ? total : Math.min(num(r.amount_paid), total)
    add(invoiced, r.currency, total)
    add(paid, r.currency, alreadyPaid)
    if (OPEN_STATUSES.includes(status)) {
      const due = r.amount_due !== null && r.amount_due !== undefined ? num(r.amount_due) : total - alreadyPaid
      add(outstanding, r.currency, Math.max(due, 0))
    }
  }
  return { invoiced, paid, outstanding }
}

/** "$1,200.00 · €300.00" (one entry per currency actually present); "$0.00" when there is nothing. */
export function formatMoneyMap(map: MoneyByCurrency): string {
  const parts = (['USD', 'EUR'] as const)
    .filter(c => map[c] !== undefined && map[c] !== 0)
    .map(c => `${c === 'EUR' ? '€' : '$'}${map[c].toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
  return parts.length > 0 ? parts.join(' · ') : '$0.00'
}

/** Generic per-currency sum for expense rows. */
export function sumExpensesByCurrency(
  rows: Array<{ status: string | null; currency: string | null; total: number | string | null }>,
  include: (status: string) => boolean,
): MoneyByCurrency {
  const out: MoneyByCurrency = {}
  for (const r of rows) {
    if (include(r.status ?? '')) add(out, r.currency, num(r.total))
  }
  return out
}
