import { describe, it, expect } from 'vitest'
import { deriveBase, CARD_FEE_DESCRIPTION } from '@/lib/finance/card-fee-booking'
import { buildRegeneratedLineItems } from '@/lib/portal/invoice-regenerate'

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

// Invoice edit/credit-apply must PRESERVE the fee line (plan TODO b, dev_task
// 6ec6872a). Was a red test (.fails) proving the gap; now green — the regeneration
// primitive carries item_type through so a fee line survives an edit as a fee line
// and the credit reduces only the service base.
describe('invoice edit preserves the fee line (fee-aware writers)', () => {
  it('keeps a fee line marked as fee through a regeneration', () => {
    const items = [
      { description: 'Service', quantity: 1, unit_price: 1000, amount: 1000, item_type: 'service' },
      { description: CARD_FEE_DESCRIPTION, quantity: 1, unit_price: 50, amount: 50, item_type: 'fee' },
    ]
    const out = buildRegeneratedLineItems(items, 0)
    const feeLine = out.find((i) => i.description === CARD_FEE_DESCRIPTION)
    expect(feeLine?.item_type).toBe('fee')
    // The service line stays a service line.
    expect(out.find((i) => i.description === 'Service')?.item_type).toBe('service')
  })

  it('applies credit against the service base only, leaving the fee line intact', () => {
    const items = [
      { description: 'Service', quantity: 1, unit_price: 1000, amount: 1000, item_type: 'service' },
      { description: CARD_FEE_DESCRIPTION, quantity: 1, unit_price: 50, amount: 50, item_type: 'fee' },
    ]
    const out = buildRegeneratedLineItems(items, 200) // apply 200 credit
    const feeLine = out.find((i) => i.description === CARD_FEE_DESCRIPTION)
    expect(feeLine).toMatchObject({ amount: 50, item_type: 'fee' }) // fee untouched
    const creditLine = out.find((i) => i.amount === -200)
    expect(creditLine?.item_type).toBe('service') // credit is a service adjustment
    // base (non-fee) = 1000 − 200 = 800; fee stays 50; total 850.
    const base = out.filter((i) => i.item_type !== 'fee').reduce((s, i) => s + i.amount, 0)
    expect(base).toBe(800)
  })
})
