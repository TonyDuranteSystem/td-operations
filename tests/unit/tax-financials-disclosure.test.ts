/**
 * The disclosure a client SIGNS must never contradict the gate above it, and
 * must never be wrong about direction or number (2026-08-03, bug-hunter).
 *
 * The first cut of the "still our suggestion" feature rendered only the folded
 * EXPENSE with a hardcoded minus and called the rows "expenses" — so a client
 * whose undecided rows were INFLOWS saw "(12) −0.00 expenses" while gate 6 on
 * the same screen said +120,000. It also read "1 transactions are" for the
 * single-leftover case, which is the normal end-state of a review.
 */

import { describe, it, expect } from 'vitest'
import { suggestedPhrase, gateSixText } from '@/lib/tax/disclosure-text'

const pnl = (over: Partial<Parameters<typeof gateSixText>[0]> = {}) => ({
  uncategorizedCount: 0,
  uncategorizedTotal: 0,
  foldedUncategorizedCount: 0,
  foldedUncategorizedIncome: 0,
  foldedUncategorizedExpense: 0,
  ...over,
})

describe('suggestedPhrase — the consent sentence must agree with itself', () => {
  it('singular does not say "1 transactions"', () => {
    expect(suggestedPhrase(1, false)).toBe('1 transaction is')
    expect(suggestedPhrase(1, true)).toBe('1 transazione è')
  })
  it('plural stays plural', () => {
    expect(suggestedPhrase(394, false)).toBe('394 transactions are')
    expect(suggestedPhrase(394, true)).toBe('394 transazioni sono')
  })
  it('zero uses the plural form (never rendered, but must not crash)', () => {
    expect(suggestedPhrase(0, false)).toBe('0 transactions are')
  })
})

describe('gateSixText — direction and language', () => {
  it('ALL-OUTFLOW: negative net, money out', () => {
    const t = gateSixText(pnl({ foldedUncategorizedCount: 394, foldedUncategorizedExpense: 151353.19 }), false)!
    expect(t).toContain('394 transactions are')
    expect(t).toContain('−151,353.19')
  })

  // THE BUG: undecided rows that are money IN. The old line showed −0.00.
  it('ALL-INFLOW: positive net, and never shown as a negative', () => {
    const t = gateSixText(pnl({ foldedUncategorizedCount: 12, foldedUncategorizedIncome: 120000 }), false)!
    expect(t).toContain('12 transactions are')
    expect(t).toContain('120,000.00')
    expect(t).not.toContain('−120,000.00')
    expect(t).not.toContain('0.00 —') // the "−0.00" symptom
  })

  it('MIXED: nets the two sides rather than reporting only the outflows', () => {
    const t = gateSixText(
      pnl({ foldedUncategorizedCount: 394, foldedUncategorizedExpense: 86712, foldedUncategorizedIncome: 120000 }),
      false,
    )!
    // 120000 − 86712 = 33,288 — NOT −86,712.
    expect(t).toContain('33,288.00')
    expect(t).not.toContain('86,712.00')
  })

  it('STAFF PATH (folding off) reports the same way from the other pair of fields', () => {
    const t = gateSixText(pnl({ uncategorizedCount: 3, uncategorizedTotal: -450 }), false)!
    expect(t).toContain('3 transactions are')
    expect(t).toContain('−450.00')
  })

  it('nothing pending → the honest all-clear, not a warning', () => {
    expect(gateSixText(pnl(), false)).toBe('You have decided every transaction.')
    expect(gateSixText(pnl(), true)).toBe('Hai deciso ogni transazione.')
  })

  // Andrea Santellocco (Economicamente) has contacts.language = 'Italian' and is
  // the client with 765 undecided rows — this sentence is the headline on his
  // screen, so it cannot be English-only.
  it('Italian client gets Italian, not English', () => {
    const t = gateSixText(pnl({ foldedUncategorizedCount: 765, foldedUncategorizedExpense: 151353.19 }), true)!
    expect(t).toContain('765 transazioni sono')
    expect(t).toContain('classificate da noi')
    expect(t).not.toMatch(/booked on our suggestion/i)
  })

  it('thousands separators, not a raw fixed-point blob', () => {
    const t = gateSixText(pnl({ foldedUncategorizedCount: 2, foldedUncategorizedExpense: 151353.19 }), false)!
    expect(t).toContain('151,353.19')
    expect(t).not.toContain('151353.19')
  })
})
