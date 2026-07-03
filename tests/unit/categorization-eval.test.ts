/**
 * Eval metrics engine (Smart Categorization v2, Phase 1) — the measurement
 * core every release gate hangs on. Pure function, exhaustively testable.
 */
import { describe, it, expect } from 'vitest'
import { computeEvalReport, DEFAULT_GATES, type EvalRow } from '@/lib/tax/categorization-eval'

const row = (over: Partial<EvalRow>): EvalRow => ({
  id: Math.random().toString(36).slice(2),
  amount: -100,
  currency: 'USD',
  predicted: 'expense',
  source: 'rule',
  label: 'expense',
  ...over,
})

describe('computeEvalReport — dollar-weighted precision', () => {
  it('weights by dollars, not rows: one wrong $50k row sinks twenty right $3 rows', () => {
    const rows: EvalRow[] = [
      ...Array.from({ length: 20 }, () => row({ amount: -3 })),                       // correct, $60
      row({ amount: -50000, predicted: 'expense', label: 'distribution', source: 'ai:high' }), // WRONG, $50k
    ]
    const r = computeEvalReport(rows)
    expect(r.autoAppliedPrecisionRows).toBeCloseTo(20 / 21, 4)   // rows look fine
    expect(r.autoAppliedPrecisionDollars).toBeCloseTo(60 / 50060, 4) // dollars tell the truth
    expect(r.gates.pass).toBe(false)
  })

  it('converts currencies with the provided IRS-average rates', () => {
    const rows: EvalRow[] = [
      row({ amount: -886, currency: 'EUR' }), // 886 EUR / 0.886 = $1000
      row({ amount: -1000, currency: 'USD' }),
    ]
    const r = computeEvalReport(rows, { fxRateToUsd: { EUR: 0.886 } })
    expect(r.totalAbsDollars).toBeCloseTo(2000, 0)
  })
})

describe('computeEvalReport — critical error classes', () => {
  it('owner draw booked as expense (the wrong-deduction class) is measured and gated', () => {
    const rows: EvalRow[] = [
      row({ amount: -10000, predicted: 'expense', label: 'distribution', source: 'ai:high' }),
      row({ amount: -90000, predicted: 'expense', label: 'expense' }),
    ]
    const r = computeEvalReport(rows)
    expect(r.ownerDrawAsExpenseDollars).toBe(10000)
    expect(r.ownerDrawAsExpenseShare).toBeCloseTo(0.1, 3)
    expect(r.gates.failures.some(f => f.includes('owner-draw-as-expense'))).toBe(true)
  })

  it('an internal-transfer leg auto-booked as income/expense fails the zero-tolerance gate', () => {
    const rows: EvalRow[] = [
      row({ amount: 30000, predicted: 'income', label: 'conversion', source: 'ai:high' }),
      row({ amount: -500, predicted: 'expense', label: 'expense' }),
    ]
    const r = computeEvalReport(rows)
    expect(r.transferLegMisbookedCount).toBe(1)
    expect(r.transferLegMisbookedDollars).toBe(30000)
    expect(r.gates.pass).toBe(false)
  })

  it('a transfer leg left UNDECIDED is honest, not a critical error', () => {
    const rows: EvalRow[] = [
      row({ amount: 30000, predicted: 'uncategorized', label: 'conversion', source: 'none', groupKey: 'g1' }),
      row({ amount: -500, predicted: 'expense', label: 'expense' }),
    ]
    const r = computeEvalReport(rows)
    expect(r.transferLegMisbookedCount).toBe(0)
    expect(r.openQuestionGroups).toBe(1)
    expect(r.gates.pass).toBe(true)
  })
})

describe('computeEvalReport — P&L delta and UX outcome', () => {
  it('|ΔP&L$| is the dollar distance between predicted and golden net income', () => {
    // Predicted books a $10k distribution as expense → predicted net is $10k LOWER.
    const rows: EvalRow[] = [
      row({ amount: 50000, predicted: 'income', label: 'income', source: 'rule' }),
      row({ amount: -10000, predicted: 'expense', label: 'distribution', source: 'ai:high' }),
    ]
    const r = computeEvalReport(rows)
    expect(r.pnlDeltaDollars).toBe(10000)
  })

  it('conversion rows never move the P&L in either direction', () => {
    const rows: EvalRow[] = [
      row({ amount: 99999, predicted: 'conversion', label: 'conversion', source: 'rule' }),
      row({ amount: 100, predicted: 'income', label: 'income', source: 'rule' }),
    ]
    const r = computeEvalReport(rows)
    expect(r.pnlDeltaDollars).toBe(0)
  })

  it('counts open question GROUPS (the human workload), not open rows', () => {
    const rows: EvalRow[] = [
      row({ predicted: 'uncategorized', source: 'none', groupKey: 'glovo' }),
      row({ predicted: 'uncategorized', source: 'none', groupKey: 'glovo' }),
      row({ predicted: 'uncategorized', source: 'none', groupKey: 'axi' }),
    ]
    const r = computeEvalReport(rows)
    expect(r.openQuestionGroups).toBe(2)
    expect(r.autoRate).toBe(0)
  })
})

describe('computeEvalReport — gates and attribution', () => {
  it('passes cleanly on a perfect run and reports per-source attribution', () => {
    const rows: EvalRow[] = [
      row({ source: 'rule' }),
      row({ source: 'ai:high', amount: -200 }),
      row({ source: 'legacy', amount: -300 }),
      row({ predicted: 'uncategorized', source: 'none', groupKey: 'g' }),
    ]
    const r = computeEvalReport(rows)
    expect(r.gates.pass).toBe(true)
    expect(r.bySource['rule'].precisionDollars).toBe(1)
    expect(r.bySource['ai:high'].dollars).toBe(200)
    expect(r.autoRate).toBeCloseTo(0.75, 2)
  })

  it('default gates match the approved plan (98% / 0.5% / zero)', () => {
    expect(DEFAULT_GATES.minAutoAppliedPrecision).toBe(0.98)
    expect(DEFAULT_GATES.maxOwnerDrawAsExpense).toBe(0.005)
    expect(DEFAULT_GATES.maxTransferLegMisbooked).toBe(0)
  })
})
