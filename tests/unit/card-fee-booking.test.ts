import { describe, it, expect } from 'vitest'
import { CARD_FEE_DESCRIPTION } from '@/lib/finance/card-fee-booking'
import { buildRegeneratedLineItems } from '@/lib/portal/invoice-regenerate'

describe('card fee line label', () => {
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
