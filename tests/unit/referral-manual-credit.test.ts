import { describe, it, expect } from 'vitest'
import { defaultReferralCreditUsd } from '@/lib/operations/referral'

describe('defaultReferralCreditUsd — 10% of referred setup fee, taken as USD', () => {
  it('computes 10% of the setup-fee total', () => {
    expect(defaultReferralCreditUsd(2000)).toBe(200)   // Azor case: €2000 → $200
    expect(defaultReferralCreditUsd(2500)).toBe(250)
    expect(defaultReferralCreditUsd(3000)).toBe(300)
    expect(defaultReferralCreditUsd(3800)).toBe(380)
  })

  it('rounds to 2 decimals', () => {
    expect(defaultReferralCreditUsd(1234.56)).toBe(123.46)
  })

  it('returns 0 for null / zero / negative (no setup fee on record)', () => {
    expect(defaultReferralCreditUsd(null)).toBe(0)
    expect(defaultReferralCreditUsd(undefined)).toBe(0)
    expect(defaultReferralCreditUsd(0)).toBe(0)
    expect(defaultReferralCreditUsd(-500)).toBe(0)
  })
})
