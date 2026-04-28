import { describe, it, expect } from 'vitest'
import { getRenewalGuard } from '@/lib/billing/renewal-guard'

describe('getRenewalGuard', () => {
  const YEAR = 2026

  it('skips Year 1 client with onboarding_date in renewal year', () => {
    expect(getRenewalGuard('2026-01-15', YEAR)).toEqual({ skipAccount: true, skipJanuary: false })
    expect(getRenewalGuard('2026-04-01', YEAR)).toEqual({ skipAccount: true, skipJanuary: false })
    expect(getRenewalGuard('2026-12-31', YEAR)).toEqual({ skipAccount: true, skipJanuary: false })
  })

  it('applies September rule for Sep–Dec of previous year', () => {
    expect(getRenewalGuard('2025-09-01', YEAR)).toEqual({ skipAccount: false, skipJanuary: true })
    expect(getRenewalGuard('2025-10-15', YEAR)).toEqual({ skipAccount: false, skipJanuary: true })
    expect(getRenewalGuard('2025-12-31', YEAR)).toEqual({ skipAccount: false, skipJanuary: true })
  })

  it('does not apply September rule for Jan–Aug of previous year', () => {
    expect(getRenewalGuard('2025-01-01', YEAR)).toEqual({ skipAccount: false, skipJanuary: false })
    expect(getRenewalGuard('2025-08-31', YEAR)).toEqual({ skipAccount: false, skipJanuary: false })
  })

  it('normal renewal for clients older than 1 year', () => {
    expect(getRenewalGuard('2024-03-01', YEAR)).toEqual({ skipAccount: false, skipJanuary: false })
    expect(getRenewalGuard('2023-09-15', YEAR)).toEqual({ skipAccount: false, skipJanuary: false })
  })

  it('returns no-skip when tdStartDate is null', () => {
    expect(getRenewalGuard(null, YEAR)).toEqual({ skipAccount: false, skipJanuary: false })
  })

  it('September rule boundary: Aug 31 is not September rule, Sep 1 is', () => {
    expect(getRenewalGuard('2025-08-31', YEAR).skipJanuary).toBe(false)
    expect(getRenewalGuard('2025-09-01', YEAR).skipJanuary).toBe(true)
  })
})
