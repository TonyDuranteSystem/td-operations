import { describe, it, expect } from 'vitest'
import { salesTotals, formatMoneyMap, sumExpensesByCurrency } from '@/lib/portal/invoice-totals'

const row = (status: string, total: number, extra: Record<string, unknown> = {}) => ({ status, currency: 'USD', total, amount_paid: 0, amount_due: total, ...extra })

describe('salesTotals', () => {
  it('never adds euros and dollars together', () => {
    const t = salesTotals([row('Sent', 1000), row('Sent', 1000, { currency: 'EUR' })])
    expect(t.invoiced).toEqual({ USD: 1000, EUR: 1000 })
    expect(formatMoneyMap(t.invoiced)).toBe('$1,000.00 · €1,000.00')
  })
  it('ignores drafts, voided invoices and the parent of a split', () => {
    const t = salesTotals([row('Draft', 500), row('Cancelled', 500), row('Split', 500), row('Sent', 100)])
    expect(t.invoiced).toEqual({ USD: 100 })
    expect(t.outstanding).toEqual({ USD: 100 })
  })
  it('counts the paid part of a part-paid invoice as paid and only the rest as outstanding', () => {
    const t = salesTotals([row('Partial', 1000, { amount_paid: 400, amount_due: 600 })])
    expect(t.paid).toEqual({ USD: 400 })
    expect(t.outstanding).toEqual({ USD: 600 })
  })
  it('a paid invoice is fully paid and owes nothing', () => {
    const t = salesTotals([row('Paid', 250, { amount_paid: 250, amount_due: 0 })])
    expect(t.paid).toEqual({ USD: 250 })
    expect(t.outstanding).toEqual({})
  })
  it('falls back to total - paid when amount_due is missing, never negative', () => {
    const t = salesTotals([{ status: 'Sent', currency: 'USD', total: 100, amount_paid: 150 }])
    expect(t.outstanding).toEqual({ USD: 0 })
  })
  it('rounds to cents', () => {
    const t = salesTotals([row('Sent', 0.1), row('Sent', 0.2)])
    expect(t.invoiced.USD).toBe(0.3)
  })
})

describe('formatMoneyMap', () => {
  it('shows $0.00 when empty', () => { expect(formatMoneyMap({})).toBe('$0.00') })
  it('shows a single currency plainly', () => { expect(formatMoneyMap({ EUR: 12.5 })).toBe('€12.50') })
})

describe('sumExpensesByCurrency', () => {
  it('groups by currency and respects the filter', () => {
    const rows = [
      { status: 'Paid', currency: 'USD', total: 10 }, { status: 'Pending', currency: 'EUR', total: 20 }, { status: 'Cancelled', currency: 'USD', total: 99 },
    ]
    expect(sumExpensesByCurrency(rows, s => s !== 'Cancelled')).toEqual({ USD: 10, EUR: 20 })
    expect(sumExpensesByCurrency(rows, s => s === 'Paid')).toEqual({ USD: 10 })
  })
})
