/**
 * Validation Mode V1 — the breakdown must REPRODUCE the draft from the same
 * inputs, or say so. Fixtures cover the adversarial-review matrix:
 * multi-currency FX, missing rates, refund contra-expense (F4), conversions
 * excluded, first-year beginning balances, related-party visibility, the
 * provenance taxonomy, and a deliberately-broken draft (invariant must fail).
 */
import { describe, it, expect } from 'vitest'
import { buildValidationBreakdown, classifyProvenance, type ValidationRow } from '@/lib/tax/validation-breakdown'
import { buildFinancialDraft, type DraftTransaction } from '@/lib/tax/financials-engine'
import type { PriorReturnCaseRecord } from '@/lib/tax/prior-return-case'
import type { OwnershipResolution } from '@/lib/tax/ownership-resolution'

let seq = 0
const row = (over: Partial<ValidationRow & DraftTransaction> = {}): ValidationRow & DraftTransaction => ({
  id: `r${seq++}`,
  transaction_date: '2024-06-01',
  description: 'GENERIC',
  counterparty: '',
  amount: -100,
  currency: 'USD',
  category: 'expense',
  subcategory: null,
  bank_name: 'Wise',
  account_type: 'USD',
  balance_after: null,
  notes: null,
  is_related_party: false,
  ...over,
})

const NO_OWNERS: OwnershipResolution = { members: [], conflicts: [], unresolved: [] } as unknown as OwnershipResolution
const FIRST_YEAR: PriorReturnCaseRecord = { case: 'first_year', status: 'first_year', formation_date: '2024-01-05', note: 'x', recorded_at: 'now' }

/** Build draft + breakdown from the SAME rows/rates — the production wiring. */
function build(rows: Array<ValidationRow & DraftTransaction>, fxRates?: Record<string, number>, prior: PriorReturnCaseRecord | null = null) {
  const draft = buildFinancialDraft({ taxYear: 2024, transactions: rows, members: [], priorReturn: prior, defaultUncategorizedBySign: false, fxRates })
  const breakdown = buildValidationBreakdown({ rows, draft, fxRates, priorReturn: prior, ownership: NO_OWNERS })
  return { draft, breakdown }
}

describe('classifyProvenance (marker taxonomy)', () => {
  const cases: Array<[string | null, string, string]> = [
    [null, 'expense', 'rules_memory'],
    ['', 'income', 'rules_memory'],
    ['ai:high@v4:g12', 'expense', 'ai'],
    ['manual: staff answer (business)', 'expense', 'human_answer'],
    ['manual: bulk staff answer (personal)', 'distribution', 'human_answer'],
    ['manual: country answer abc-123', 'expense', 'location_answer'],
    ['manual: period answer abc-123', 'distribution', 'location_answer'],
    ['auto: zero-amount', 'conversion', 'auto_zero'],
    ['transfer-pair → xyz', 'conversion', 'transfer_matcher'],
    ['own-entity transfer', 'conversion', 'transfer_matcher'],
    [null, 'uncategorized', 'open'],
    ['ai:high@v4', 'uncategorized', 'open'], // open wins — the row is NOT booked
  ]
  for (const [notes, category, expected] of cases) {
    it(`${JSON.stringify(notes)} + ${category} → ${expected}`, () => {
      expect(classifyProvenance({ notes, category })).toBe(expected)
    })
  }
})

describe('invariant: breakdown reproduces the draft', () => {
  it('multi-currency workspace — every line matches, rates visible', () => {
    const rows = [
      row({ category: 'income', amount: 1000 }),
      row({ category: 'income', amount: 924, currency: 'EUR' }),      // ÷0.924 = 1000 USD
      row({ category: 'expense', amount: -462, currency: 'EUR' }),    // ÷0.924 = -500 USD
      row({ category: 'expense', amount: -200 }),
      row({ category: 'refund', amount: 50 }),                        // contra-expense (F4)
      row({ category: 'distribution', amount: -300 }),
      row({ category: 'conversion', amount: -5000, notes: 'transfer-pair → x' }),
      row({ category: 'uncategorized', amount: -75 }),
    ]
    const { draft, breakdown } = build(rows, { EUR: 0.924 })
    expect(breakdown.invariant.ok).toBe(true)
    const revenue = breakdown.pnl_lines.find(l => l.key === 'income')!
    expect(revenue.total_usd).toBeCloseTo(draft.pnl.totalIncome, 2)
    expect(revenue.total_usd).toBeCloseTo(2000, 2)
    const eur = revenue.by_currency.find(c => c.currency === 'EUR')!
    expect(eur.sum_original).toBe(924)
    expect(eur.rate).toBe(0.924)
    expect(eur.sum_usd).toBeCloseTo(1000, 2)
    const expenses = breakdown.pnl_lines.find(l => l.key === 'expenses')!
    expect(expenses.total_usd).toBeCloseTo(draft.pnl.totalExpenses, 2)
    expect(expenses.total_usd).toBeCloseTo(650, 2) // 500 + 200 − 50 refund
    expect(expenses.refunds).toEqual({ count: 1, total_usd: expect.closeTo(-50, 2) })
    expect(breakdown.exclusions.conversions).toEqual({ count: 1, total_abs_usd: expect.closeTo(5000, 2) })
    expect(breakdown.exclusions.unclassified.count).toBe(1)
  })

  it('missing FX rate — flagged, still matches the draft (both leave it unconverted)', () => {
    const rows = [row({ category: 'expense', amount: -1921.2, currency: 'HKD' })]
    const { draft, breakdown } = build(rows, { EUR: 0.924 }) // no HKD rate
    expect(breakdown.invariant.ok).toBe(true)
    expect(breakdown.exclusions.missing_rate_currencies).toEqual(['HKD'])
    const line = breakdown.pnl_lines.find(l => l.key === 'expenses')!
    expect(line.by_currency[0].missing_rate).toBe(true)
    expect(line.total_usd).toBeCloseTo(draft.pnl.totalExpenses, 2)
  })

  it('first-year: beginning cash derivation says zero-by-declaration', () => {
    const rows = [row({ category: 'income', amount: 500 })]
    const { breakdown } = build(rows, undefined, FIRST_YEAR)
    const begin = breakdown.bs_derivations.find(b => b.key === 'beginning_cash')!
    expect(begin.note).toContain('First year')
    expect(breakdown.policy_inputs.prior_return).toMatchObject({ case: 'first_year', status: 'first_year' })
    const ending = breakdown.bs_derivations.find(b => b.key === 'ending_cash')!
    expect(ending.value).toBeCloseTo(500, 2)
    expect(breakdown.invariant.ok).toBe(true)
  })

  it('related-party rows surface per line and workspace-wide', () => {
    const rows = [
      row({ category: 'expense', amount: -800, is_related_party: true, counterparty: 'Acme FZCO' }),
      row({ category: 'expense', amount: -100 }),
      row({ category: 'income', amount: 900, is_related_party: true, counterparty: 'Acme FZCO' }),
    ]
    const { breakdown } = build(rows)
    expect(breakdown.related_party.count).toBe(2)
    expect(breakdown.related_party.total_abs_usd).toBeCloseTo(1700, 2)
    expect(breakdown.related_party.top_counterparties[0].label).toBe('Acme FZCO')
    expect(breakdown.pnl_lines.find(l => l.key === 'expenses')!.related_party).toEqual({ count: 1, total_usd: expect.closeTo(800, 2) })
    expect(breakdown.pnl_lines.find(l => l.key === 'income')!.related_party).toEqual({ count: 1, total_usd: expect.closeTo(900, 2) })
  })

  it('provenance split covers the whole workspace with the right classes', () => {
    const rows = [
      row({ category: 'expense', notes: 'ai:high@v4:g3' }),
      row({ category: 'expense', notes: 'manual: staff answer (business)' }),
      row({ category: 'expense', notes: 'manual: country answer b1' }),
      row({ category: 'conversion', notes: 'auto: zero-amount', amount: 0 }),
      row({ category: 'expense' }), // rules/memory
      row({ category: 'uncategorized' }),
    ]
    const { breakdown } = build(rows)
    const byClass = Object.fromEntries(breakdown.provenance.map(p => [p.class, p.count]))
    expect(byClass).toEqual({ ai: 1, human_answer: 1, location_answer: 1, auto_zero: 1, rules_memory: 1, open: 1 })
  })

  it('a draft the breakdown cannot reproduce FAILS the invariant loudly', () => {
    const rows = [row({ category: 'income', amount: 1000 })]
    const draft = buildFinancialDraft({ taxYear: 2024, transactions: rows, members: [], priorReturn: null, defaultUncategorizedBySign: false })
    const broken = { ...draft, pnl: { ...draft.pnl, totalIncome: 999999 } }
    const breakdown = buildValidationBreakdown({ rows, draft: broken, priorReturn: null, ownership: NO_OWNERS })
    expect(breakdown.invariant.ok).toBe(false)
    expect(breakdown.invariant.mismatches[0]).toMatchObject({ line: 'Revenue', draft: 999999 })
  })
})
