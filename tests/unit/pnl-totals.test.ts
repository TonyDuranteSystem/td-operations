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
