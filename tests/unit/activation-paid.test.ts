import { describe, it, expect } from 'vitest'
import { isActivationEffectivelyPaid } from '@/lib/operations/activation-paid'

const T = '2026-06-10T11:15:30Z'

describe('isActivationEffectivelyPaid', () => {
  it('paid when payment_confirmed_at is set (any method)', () => {
    expect(isActivationEffectivelyPaid({ payment_confirmed_at: T, activated_at: null, payment_method: 'stripe' })).toBe(true)
    expect(isActivationEffectivelyPaid({ payment_confirmed_at: T, activated_at: null, payment_method: 'none' })).toBe(true)
  })

  it('paid when activated and method is not the decoupled "none" (Michele case: bank_transfer, no confirmed_at)', () => {
    expect(isActivationEffectivelyPaid({ payment_confirmed_at: null, activated_at: T, payment_method: 'bank_transfer' })).toBe(true)
    expect(isActivationEffectivelyPaid({ payment_confirmed_at: null, activated_at: T, payment_method: 'wire' })).toBe(true)
    expect(isActivationEffectivelyPaid({ payment_confirmed_at: null, activated_at: T, payment_method: 'unknown' })).toBe(true)
  })

  it('NOT paid when activated via the decoupled "Activate Now" path (payment_method=none)', () => {
    expect(isActivationEffectivelyPaid({ payment_confirmed_at: null, activated_at: T, payment_method: 'none' })).toBe(false)
  })

  it('NOT paid when signed but neither confirmed nor activated', () => {
    expect(isActivationEffectivelyPaid({ payment_confirmed_at: null, activated_at: null, payment_method: 'bank_transfer' })).toBe(false)
  })

  it('NOT paid for null / undefined activation', () => {
    expect(isActivationEffectivelyPaid(null)).toBe(false)
    expect(isActivationEffectivelyPaid(undefined)).toBe(false)
  })
})
