import { describe, it, expect } from 'vitest'
import { deriveBase, CARD_FEE_DESCRIPTION } from '@/lib/finance/card-fee-booking'

describe('deriveBase (immutable base = sum of non-fee line items)', () => {
  it('sums only the non-fee lines', () => {
    const base = deriveBase({ total: 3150, amount: 3150 }, [
      { amount: 2500, item_type: 'service' },
      { amount: 500, item_type: 'service' },
      { amount: 150, item_type: 'fee' },
    ])
    expect(base).toBe(3000)
  })

  it('ignores an existing fee line so re-booking never compounds', () => {
    // invoice already carries a fee line + bumped total; base must stay 3000
    const base = deriveBase({ total: 3150, amount: 3150 }, [
      { amount: 3000, item_type: 'service' },
      { amount: 150, item_type: 'fee' },
    ])
    expect(base).toBe(3000)
  })

  it('falls back to the invoice PRE-BUMP total when there are no line items', () => {
    expect(deriveBase({ total: 1200, amount: 1200 }, [])).toBe(1200)
    expect(deriveBase({ total: null, amount: 800 }, [])).toBe(800)
  })

  it('treats a null item_type as a service line (legacy rows)', () => {
    expect(deriveBase({ total: 0, amount: 0 }, [{ amount: 900, item_type: null }])).toBe(900)
  })

  it('is cent-accurate', () => {
    expect(deriveBase({ total: 0, amount: 0 }, [
      { amount: 33.33, item_type: 'service' },
      { amount: 66.67, item_type: 'service' },
    ])).toBe(100)
  })

  it('exports the fee description used as the line label', () => {
    expect(CARD_FEE_DESCRIPTION).toBe('Card processing fee')
  })
})
