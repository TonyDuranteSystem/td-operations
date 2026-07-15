import { describe, it, expect } from 'vitest'
import {
  computeCardTotal,
  deriveFeeFromCharge,
  normalizeRate,
  round2,
  DEFAULT_CARD_FEE_RATE,
} from '@/lib/payments/card-fee'

describe('normalizeRate', () => {
  it('accepts sane rates incl. strings from the DB', () => {
    expect(normalizeRate(0.05)).toBe(0.05)
    expect(normalizeRate('0.07')).toBe(0.07)
    expect(normalizeRate(0)).toBe(0)
  })
  it('falls back to default on garbage — bad config must never price a deal', () => {
    for (const bad of [null, undefined, NaN, -1, 5, 'abc']) {
      expect(normalizeRate(bad as never)).toBe(DEFAULT_CARD_FEE_RATE)
    }
  })
})

describe('computeCardTotal (display + what we ask the gateway to charge)', () => {
  it('adds the fee and keeps base + fee === cardTotal', () => {
    const r = computeCardTotal(3000, 0.05)
    expect(r).toMatchObject({ base: 3000, fee: 150, cardTotal: 3150, appliedRate: 0.05 })
    expect(r.base + r.fee).toBe(r.cardTotal)
  })
  it('honours a configured non-default rate and 0', () => {
    expect(computeCardTotal(1000, 0.07).cardTotal).toBe(1070)
    expect(computeCardTotal(1000, 0).cardTotal).toBe(1000)
  })
  it('keeps cents to 2dp (no float dust into the ledger)', () => {
    const r = computeCardTotal(1234.56, 0.05)
    expect(r.cardTotal).toBe(round2(1234.56 * 1.05))
    expect(Number.isInteger(r.fee * 100)).toBe(true)
  })
  it('is safe on zero/negative', () => {
    expect(computeCardTotal(0, 0.05).cardTotal).toBe(0)
    expect(computeCardTotal(-5, 0.05).cardTotal).toBe(0)
  })
})

describe('deriveFeeFromCharge (booking — from the ACTUAL charge, never a recompute)', () => {
  it('books fee = charged − base when the charge matches', () => {
    const d = deriveFeeFromCharge(3000, 3150, 0.05)
    expect(d).toMatchObject({ valid: true, fee: 150, base: 3000, chargedAmount: 3150 })
  })

  // The key reason we book from the charge, not a recompute: an off-by-a-unit gateway
  // rounding must still be booked exactly, not "corrected" to our recomputed number.
  it('books the exact gateway amount even when it is a unit off the naive rate', () => {
    // base 999, charged 1049 (gateway rounded), naive 999*0.05=49.95 → within slack
    const d = deriveFeeFromCharge(999, 1049, 0.05)
    expect(d.valid).toBe(true)
    expect(d.fee).toBe(50)
  })

  it('INVALID when charged < base (never book a negative fee)', () => {
    expect(deriveFeeFromCharge(3000, 2900, 0.05).valid).toBe(false)
  })

  it('INVALID when charged − base is way over the expected fee (base mismatch)', () => {
    // charged 5000 vs base 3000 → diff 2000, expected max ~151 → invalid
    const d = deriveFeeFromCharge(3000, 5000, 0.05)
    expect(d.valid).toBe(false)
    expect(d.fee).toBe(2000) // still reported, but caller must not book it
  })

  it('INVALID when base is zero/unknown', () => {
    expect(deriveFeeFromCharge(0, 150, 0.05).valid).toBe(false)
  })

  it('allows a base-only charge (fee 0) as valid', () => {
    expect(deriveFeeFromCharge(3000, 3000, 0.05)).toMatchObject({ valid: true, fee: 0 })
  })
})
