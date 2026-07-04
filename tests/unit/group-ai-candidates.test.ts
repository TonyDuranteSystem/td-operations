/**
 * Group-level AI candidates (Phase 3R-B) — eligibility rules, currency/sign
 * splits, stable representative, fan-out mechanics. Every exclusion here
 * prevents a single group verdict from booking unrelated rows (review F1-F4).
 */
import { describe, it, expect } from 'vitest'
import { buildGroupedAiCandidates, expandSuggestionMembers } from '@/lib/tax/group-ai-candidates'
import type { AiCategorizableTx } from '@/lib/tax/ai-categorizer'

let n = 0
const tx = (over: Partial<AiCategorizableTx>): AiCategorizableTx => ({
  id: `t${String(n++).padStart(3, '0')}`,
  transaction_date: '2025-03-01',
  description: 'Glovo',
  counterparty: '',
  amount: -20,
  currency: 'USD',
  bank_name: 'Mercury',
  ...over,
})

describe('buildGroupedAiCandidates — grouping', () => {
  it('repeated merchants collapse to ONE representative carrying count and total', () => {
    const rows = [tx({ description: 'Glovo 12MAR', amount: -10 }), tx({ description: 'Glovo 09MAR', amount: -20 }), tx({ description: 'Glovo', amount: -30 })]
    const { txs, expansion } = buildGroupedAiCandidates(rows)
    expect(txs).toHaveLength(1)
    expect(txs[0].group_count).toBe(3)
    expect(txs[0].group_total).toBe(-60)
    expect(expansion.get(txs[0].id)).toHaveLength(3)
    expect(expansion.get(txs[0].id)).toContain(txs[0].id) // members INCLUDE the rep
  })

  it('direction splits the group: PayPal-style in/out merchants get two independent verdicts', () => {
    const rows = [tx({ description: 'Alpha Business', amount: 100 }), tx({ description: 'Alpha Business', amount: 200 }), tx({ description: 'Alpha Business', amount: -50 }), tx({ description: 'Alpha Business', amount: -60 })]
    const { txs } = buildGroupedAiCandidates(rows)
    expect(txs).toHaveLength(2)
    expect(txs.map(t => t.group_count).sort()).toEqual([2, 2])
  })

  it('currency splits the group: Glovo-EUR and Glovo-USD are separate (one line renders one currency)', () => {
    const rows = [tx({ currency: 'EUR', amount: -10 }), tx({ currency: 'EUR', amount: -15 }), tx({ currency: 'USD', amount: -20 }), tx({ currency: 'USD', amount: -25 })]
    const { txs } = buildGroupedAiCandidates(rows)
    expect(txs).toHaveLength(2)
    const eur = txs.find(t => t.currency === 'EUR')!
    expect(eur.group_total).toBe(-25)
  })

  it('the representative is stable under row-order permutation (first by id)', () => {
    const rows = [tx({ amount: -11 }), tx({ amount: -12 }), tx({ amount: -13 })] // same merchant root
    const shuffled = [rows[2], rows[0], rows[1]]
    const a = buildGroupedAiCandidates(rows)
    const b = buildGroupedAiCandidates(shuffled)
    expect(a.txs).toHaveLength(1)
    expect(a.txs[0].id).toBe(b.txs[0].id)
  })

  it('singletons pass through byte-identical (no group fields)', () => {
    const { txs, expansion } = buildGroupedAiCandidates([tx({ description: 'Unique Merchant XYZ' })])
    expect(txs[0].group_count).toBeUndefined()
    expect(expansion.size).toBe(0)
  })
})

describe('buildGroupedAiCandidates — INELIGIBLE keys stay row-level (the F1 catastrophe guards)', () => {
  it('"(no description)" bucket rows are never grouped', () => {
    const rows = [tx({ description: '', counterparty: '' }), tx({ description: '', counterparty: '' })]
    const { txs, expansion } = buildGroupedAiCandidates(rows)
    expect(txs).toHaveLength(2)
    expect(expansion.size).toBe(0)
  })

  it('degenerate last-resort roots ("Unknown - Corporate Card" w/o counterparty) are never grouped', () => {
    const rows = [
      tx({ description: 'Unknown - Corporate Card - 6921 (Business Card)' }),
      tx({ description: 'Unknown - Corporate Card - 4848 (Business Virtual Card)' }),
    ]
    const { expansion } = buildGroupedAiCandidates(rows)
    expect(expansion.size).toBe(0)
  })

  it('counterparty-fallback roots (MCC labels behind junk descriptions) are never grouped', () => {
    const rows = [
      tx({ description: 'Unknown - Corporate Card - 6921 (Business Card)', counterparty: 'Restaurants' }),
      tx({ description: 'Unknown - Corporate Card - 4848 (Business Card)', counterparty: 'Restaurants' }),
    ]
    const { expansion } = buildGroupedAiCandidates(rows)
    expect(expansion.size).toBe(0) // 137 distinct restaurants must never share one verdict
  })

  it('payment rails are never grouped', () => {
    const rows = [tx({ description: 'PayPal', amount: -10 }), tx({ description: 'PayPal', amount: -20 })]
    const { expansion } = buildGroupedAiCandidates(rows)
    expect(expansion.size).toBe(0)
  })

  it('zero-amount rows are never grouped', () => {
    const rows = [tx({ description: 'Glovo Z', amount: 0 }), tx({ description: 'Glovo Z', amount: 0 })]
    const { expansion } = buildGroupedAiCandidates(rows)
    expect(expansion.size).toBe(0)
  })
})

describe('expandSuggestionMembers — fan-out honors the written set (F2)', () => {
  it('returns all members first pass; only the unwritten remainder on reconcile', () => {
    const expansion = new Map([['rep', ['rep', 'm1', 'm2', 'm3']]])
    expect(expandSuggestionMembers('rep', expansion, new Set())).toEqual(['rep', 'm1', 'm2', 'm3'])
    expect(expandSuggestionMembers('rep', expansion, new Set(['rep', 'm1']))).toEqual(['m2', 'm3'])
    expect(expandSuggestionMembers('rep', expansion, new Set(['rep', 'm1', 'm2', 'm3']))).toEqual([])
  })
  it('ungrouped suggestion falls back to itself', () => {
    expect(expandSuggestionMembers('solo', new Map(), new Set())).toEqual(['solo'])
    expect(expandSuggestionMembers('solo', new Map(), new Set(['solo']))).toEqual([])
  })
})
