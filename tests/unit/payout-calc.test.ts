import { describe, it, expect } from 'vitest'
import { calculatePartnerPayout } from '@/lib/partners/payout-calc'

// ─── price_difference ─────────────────────────────────────────

describe('calculatePartnerPayout — price_difference', () => {
  it('computes paid − base cost', () => {
    const r = calculatePartnerPayout({
      model: 'price_difference',
      rate: null,
      paymentAmount: 1500,
      tdBaseCost: 800,
    })
    expect(r.amount).toBe(700)
    expect(r.error).toBeUndefined()
    expect(r.model).toBe('price_difference')
  })

  it('rounds to 2 decimals', () => {
    const r = calculatePartnerPayout({
      model: 'price_difference',
      rate: null,
      paymentAmount: 1500.555,
      tdBaseCost: 800.111,
    })
    expect(r.amount).toBe(700.44)
  })

  it('returns error when base cost is missing (null)', () => {
    const r = calculatePartnerPayout({
      model: 'price_difference',
      rate: null,
      paymentAmount: 1500,
      tdBaseCost: null,
    })
    expect(r.amount).toBeNull()
    expect(r.error).toBe('missing_base_cost')
  })

  it('returns error when base cost is undefined', () => {
    const r = calculatePartnerPayout({
      model: 'price_difference',
      rate: null,
      paymentAmount: 1500,
    })
    expect(r.amount).toBeNull()
    expect(r.error).toBe('missing_base_cost')
  })

  it('clamps to 0 when paid < base cost (loss-leader scenario)', () => {
    const r = calculatePartnerPayout({
      model: 'price_difference',
      rate: null,
      paymentAmount: 500,
      tdBaseCost: 800,
    })
    expect(r.amount).toBe(0)
    expect(r.error).toBe('negative_result')
  })
})

// ─── percentage ─────────────────────────────────────────

describe('calculatePartnerPayout — percentage', () => {
  it('treats rate <= 1 as fraction (0.10 = 10%)', () => {
    const r = calculatePartnerPayout({
      model: 'percentage',
      rate: 0.1,
      paymentAmount: 1000,
      tdBaseCost: null,
    })
    expect(r.amount).toBe(100)
    expect(r.error).toBeUndefined()
  })

  it('treats rate > 1 as whole-number percent (10 = 10%)', () => {
    const r = calculatePartnerPayout({
      model: 'percentage',
      rate: 10,
      paymentAmount: 1000,
      tdBaseCost: null,
    })
    expect(r.amount).toBe(100)
  })

  it('treats rate = 1 as 100%', () => {
    const r = calculatePartnerPayout({
      model: 'percentage',
      rate: 1,
      paymentAmount: 500,
      tdBaseCost: null,
    })
    expect(r.amount).toBe(500)
  })

  it('returns error when rate is missing', () => {
    const r = calculatePartnerPayout({
      model: 'percentage',
      rate: null,
      paymentAmount: 1000,
      tdBaseCost: null,
    })
    expect(r.amount).toBeNull()
    expect(r.error).toBe('missing_rate')
  })

  it('clamps negative rate to 0', () => {
    const r = calculatePartnerPayout({
      model: 'percentage',
      rate: -10,
      paymentAmount: 1000,
      tdBaseCost: null,
    })
    expect(r.amount).toBe(0)
    expect(r.error).toBe('negative_result')
  })

  it('rounds to 2 decimals', () => {
    const r = calculatePartnerPayout({
      model: 'percentage',
      rate: 0.123,
      paymentAmount: 1000,
      tdBaseCost: null,
    })
    expect(r.amount).toBe(123)
  })
})

// ─── flat_fee ─────────────────────────────────────────

describe('calculatePartnerPayout — flat_fee', () => {
  it('returns the flat amount regardless of payment', () => {
    const r = calculatePartnerPayout({
      model: 'flat_fee',
      rate: 50,
      paymentAmount: 999999,
      tdBaseCost: null,
    })
    expect(r.amount).toBe(50)
    expect(r.error).toBeUndefined()
  })

  it('returns error when rate is missing', () => {
    const r = calculatePartnerPayout({
      model: 'flat_fee',
      rate: null,
      paymentAmount: 1000,
      tdBaseCost: null,
    })
    expect(r.amount).toBeNull()
    expect(r.error).toBe('missing_rate')
  })

  it('clamps negative flat fee to 0', () => {
    const r = calculatePartnerPayout({
      model: 'flat_fee',
      rate: -25,
      paymentAmount: 1000,
      tdBaseCost: null,
    })
    expect(r.amount).toBe(0)
    expect(r.error).toBe('negative_result')
  })
})

// ─── credit_note ─────────────────────────────────────────

describe('calculatePartnerPayout — credit_note', () => {
  it('returns the credit amount (treated like flat fee)', () => {
    const r = calculatePartnerPayout({
      model: 'credit_note',
      rate: 75,
      paymentAmount: 1500,
      tdBaseCost: null,
    })
    expect(r.amount).toBe(75)
    expect(r.error).toBeUndefined()
  })

  it('returns error when rate is missing', () => {
    const r = calculatePartnerPayout({
      model: 'credit_note',
      rate: null,
      paymentAmount: 1000,
      tdBaseCost: null,
    })
    expect(r.error).toBe('missing_rate')
  })
})

// ─── none ─────────────────────────────────────────

describe('calculatePartnerPayout — none', () => {
  it('returns model_none error so caller skips the row', () => {
    const r = calculatePartnerPayout({
      model: 'none',
      rate: null,
      paymentAmount: 1000,
      tdBaseCost: 500,
    })
    expect(r.amount).toBeNull()
    expect(r.error).toBe('model_none')
  })
})

// ─── edge cases ─────────────────────────────────────────

describe('calculatePartnerPayout — edge cases', () => {
  it('returns 0 amount when payment is 0', () => {
    const r = calculatePartnerPayout({
      model: 'percentage',
      rate: 0.1,
      paymentAmount: 0,
      tdBaseCost: null,
    })
    expect(r.amount).toBe(0)
  })

  it('returns 0 amount when payment is negative (refund/chargeback)', () => {
    const r = calculatePartnerPayout({
      model: 'percentage',
      rate: 0.1,
      paymentAmount: -500,
      tdBaseCost: null,
    })
    expect(r.amount).toBe(0)
  })

  it('always echoes back the model in the result', () => {
    const r = calculatePartnerPayout({
      model: 'flat_fee',
      rate: 100,
      paymentAmount: 1000,
      tdBaseCost: null,
    })
    expect(r.model).toBe('flat_fee')
  })
})
