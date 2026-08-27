/**
 * computePnlTotals — regression tests for the three engine flaws found in the
 * 2026-06-10/11 master-plan audit (sysdoc tax-financials-self-service-master-plan §4):
 *  F1 — refunds must be SIGNED: a refund received reduces expenses, the old
 *       Math.abs() made it inflate them.
 *  F3 — capital contributions ("Top Up via") are equity, never revenue.
 *  F2 — uncategorized transactions are surfaced (count + net) so no document
 *       can silently pretend to be complete.
 */

import { describe, it, expect } from 'vitest'
import { computePnlTotals } from '@/lib/pnl-generator'
import { categorizeTransaction, type ParsedTransaction } from '@/lib/bank-statement-parser'

const tx = (category: string, amount: number) => ({ category, amount })

describe('computePnlTotals — default-by-sign policy (portal tax review)', () => {
  it('OFF (default): uncategorized rows stay pending and out of net income', () => {
    const t = computePnlTotals([tx('income', 1000), tx('uncategorized', -300), tx('uncategorized', 50)])
    expect(t.totalIncome).toBe(1000)
    expect(t.totalExpenses).toBe(0)
    expect(t.netIncome).toBe(1000)
    expect(t.uncategorizedCount).toBe(2)
  })

  it('ON: an uncategorized OUTflow defaults to a business expense', () => {
    const t = computePnlTotals([tx('income', 1000), tx('uncategorized', -300)], { defaultUncategorizedBySign: true })
    expect(t.totalExpenses).toBe(300)
    expect(t.netIncome).toBe(700)
    expect(t.uncategorizedCount).toBe(0) // nothing pending → gate 6 passes
  })

  it('ON: an uncategorized INflow defaults to income', () => {
    const t = computePnlTotals([tx('uncategorized', 500), tx('expense', -100)], { defaultUncategorizedBySign: true })
    expect(t.totalIncome).toBe(500)
    expect(t.totalExpenses).toBe(100)
    expect(t.netIncome).toBe(400)
    expect(t.uncategorizedCount).toBe(0)
  })

  it('ON: a flagged exception (distribution) is NOT counted as an expense', () => {
    // The owner flagged a personal charge → it persists as `distribution`, so it
    // leaves the uncategorized bucket and does not reduce net income.
    const t = computePnlTotals([tx('income', 1000), tx('distribution', -200), tx('uncategorized', -100)], { defaultUncategorizedBySign: true })
    expect(t.totalExpenses).toBe(100) // only the still-uncategorized 100 defaults to expense
    expect(t.totalDistributions).toBe(200)
    expect(t.netIncome).toBe(900)
  })
})

describe('computePnlTotals', () => {
  it('F1: a refund RECEIVED reduces expenses instead of inflating them', () => {
    const t = computePnlTotals([
      tx('expense', -1000),
      tx('refund', 200), // money back from a vendor
    ])
    expect(t.totalExpenses).toBe(800)
    expect(t.netIncome).toBe(-800)
  })

  it('F1: a refund PAID OUT still increases expenses', () => {
    const t = computePnlTotals([
      tx('expense', -1000),
      tx('refund', -150), // refunding someone
    ])
    expect(t.totalExpenses).toBe(1150)
  })

  it('F4: a POSITIVE amount inside the expense category is a contra-expense and REDUCES the total', () => {
    // Antonio's Uxio case: a vendor payment (-4002) later reversed (+4002).
    // The pair must net to zero expense, not be double-counted by Math.abs.
    const t = computePnlTotals([
      tx('expense', -4002),
      tx('expense', 4002), // money returned / reversal
    ])
    expect(t.totalExpenses).toBe(0)
  })

  it('F4: returned money nets down a real expense total (no abs double-count)', () => {
    const t = computePnlTotals([
      tx('income', 10000),
      tx('expense', -1000),
      tx('expense', -2000),
      tx('expense', 500), // partial refund from a vendor
    ])
    expect(t.totalExpenses).toBe(2500) // 1000 + 2000 − 500, NOT 3500
    expect(t.netIncome).toBe(7500)
  })

  it('F4: a COGS refund reduces COGS rather than inflating it', () => {
    const t = computePnlTotals([
      tx('income', 5000),
      tx('cogs', -2000),
      tx('cogs', 300), // supplier credit
    ])
    expect(t.totalCogs).toBe(1700)
    expect(t.grossProfit).toBe(3300)
  })

  it('F3: contributions are excluded from revenue and tracked separately', () => {
    const t = computePnlTotals([
      tx('income', 5000),
      tx('contribution', 50000), // owner tops up the company account
    ])
    expect(t.totalIncome).toBe(5000) // NOT 55000
    expect(t.totalContributions).toBe(50000)
    expect(t.netIncome).toBe(5000)
  })

  it('F2: uncategorized count and net are reported, never silently dropped', () => {
    const t = computePnlTotals([
      tx('income', 100),
      tx('uncategorized', 999),
      tx('uncategorized', -99),
    ])
    expect(t.uncategorizedCount).toBe(2)
    expect(t.uncategorizedTotal).toBe(900)
    expect(t.totalIncome).toBe(100) // excluded from totals, but visibly reported
  })

  it('distributions stay out of the P&L and are totaled on their own', () => {
    const t = computePnlTotals([
      tx('income', 1000),
      tx('distribution', -400),
    ])
    expect(t.netIncome).toBe(1000)
    expect(t.totalDistributions).toBe(400)
  })

  it('F5 (Dynamiq, 2026-08-27): a POSITIVE amount inside the distribution category is a refund/reversal of an earlier draw and REDUCES the total, not doubles it', () => {
    // A $931.51 corporate-card credit refunding an earlier personal draw was
    // counted as a SECOND withdrawal by the old Math.abs()-per-row formula,
    // inflating totalDistributions by 2x931.51 and breaking the balance-sheet
    // tie by the same amount. Same bug shape as F4, just missed for this category.
    const t = computePnlTotals([
      tx('distribution', -1058.41),
      tx('distribution', -779.81),
      tx('distribution', 931.51), // corporate-card refund of an earlier draw
    ])
    expect(t.totalDistributions).toBeCloseTo(906.71, 2) // 1058.41 + 779.81 − 931.51, NOT 2769.73
  })

  it('F5: a distribution and its exact reversal net to zero, not double-counted', () => {
    const t = computePnlTotals([
      tx('distribution', -4002),
      tx('distribution', 4002), // fully reversed
    ])
    expect(t.totalDistributions).toBe(0)
  })
})

describe('computePnlTotals — folded-visibility fields (2026-07-02, B&P $594k incident)', () => {
  // Under the by-sign policy the totals LOOK complete (uncategorizedCount forced
  // to 0 for gate 6) while unclassified money silently sits inside income and
  // expenses. The folded* fields expose exactly what was folded so a surface
  // can WARN. They must be additive: every pre-existing field stays identical.

  it('ON: folded fields report what was silently absorbed', () => {
    const t = computePnlTotals(
      [tx('income', 1000), tx('uncategorized', 500), tx('uncategorized', 250), tx('uncategorized', -300)],
      { defaultUncategorizedBySign: true },
    )
    expect(t.foldedUncategorizedCount).toBe(3)
    expect(t.foldedUncategorizedIncome).toBe(750) // inflows absorbed into revenue
    expect(t.foldedUncategorizedExpense).toBe(300) // outflows absorbed into expenses (positive magnitude)
    // Pre-existing behavior byte-identical: totals include the folded money,
    // pending counters still report 0 (gate 6 unchanged).
    expect(t.totalIncome).toBe(1750)
    expect(t.totalExpenses).toBe(300)
    expect(t.uncategorizedCount).toBe(0)
    expect(t.uncategorizedTotal).toBe(0)
  })

  it('OFF: nothing was folded — folded fields are zero, visible bucket carries the rows', () => {
    const t = computePnlTotals([tx('income', 1000), tx('uncategorized', 500), tx('uncategorized', -300)])
    expect(t.foldedUncategorizedCount).toBe(0)
    expect(t.foldedUncategorizedIncome).toBe(0)
    expect(t.foldedUncategorizedExpense).toBe(0)
    expect(t.uncategorizedCount).toBe(2)
    expect(t.uncategorizedTotal).toBe(200) // net of +500 −300 — the exact balance-sheet gap
    // And the unknown money is OUT of the P&L (staff workspace policy).
    expect(t.totalIncome).toBe(1000)
    expect(t.totalExpenses).toBe(0)
    expect(t.netIncome).toBe(1000)
  })

  it('OFF: uncategorizedTotal equals the assets-vs-equity gap the BS reconciling line must name', () => {
    // Cash moves by ALL transactions; equity only by categorized ones. The
    // difference is exactly uncategorizedTotal — asserted here so the Excel/UI
    // reconciling line stays mathematically honest.
    const rows = [tx('income', 1000), tx('expense', -400), tx('uncategorized', 700), tx('uncategorized', -100)]
    const t = computePnlTotals(rows)
    const cashMovement = rows.reduce((s, r) => s + r.amount, 0) // 1200
    const equityMovement = t.netIncome // 600 (income − expenses; no dist/contrib here)
    expect(cashMovement - equityMovement).toBe(t.uncategorizedTotal) // 600 = +700 −100
  })
})

describe('categorizeTransaction — contribution rule (F3)', () => {
  const base: ParsedTransaction = {
    transaction_date: '2025-03-01',
    description: 'Top Up via bank transfer',
    counterparty: '',
    amount: 50000,
    currency: 'USD',
    balance_after: null,
    transaction_ref: 'T1',
    bank_name: 'Wise',
    account_type: 'USD',
  }

  it('classifies an account top-up as contribution, not income', () => {
    const c = categorizeTransaction(base)
    expect(c.category).toBe('contribution')
    expect(c.subcategory).toBe('capital_contribution')
  })
})
