import { describe, it, expect } from 'vitest'
import { isMissingStartDate, type StartDateFields } from '@/lib/billing/missing-start-date'

const f = (o: Partial<StartDateFields>): StartDateFields => ({
  ra_switch_date: null,
  client_since: null,
  formation_date: null,
  hasClientOnboardingService: false,
  ...o,
})

describe('isMissingStartDate', () => {
  it('flags when there is no usable date at all', () => {
    expect(isMissingStartDate(f({}))).toBe(true)
  })

  it('flags an onboarding client with no ra_switch and no client_since (even if formation set)', () => {
    expect(isMissingStartDate(f({ hasClientOnboardingService: true, formation_date: '2020-01-01' }))).toBe(true)
  })

  it('does NOT flag a formation client that has a formation date', () => {
    expect(isMissingStartDate(f({ hasClientOnboardingService: false, formation_date: '2020-01-01' }))).toBe(false)
  })

  it('does NOT flag once ra_switch_date is set', () => {
    expect(isMissingStartDate(f({ hasClientOnboardingService: true, ra_switch_date: '2026-01-10' }))).toBe(false)
  })

  it('does NOT flag once client_since is set', () => {
    expect(isMissingStartDate(f({ hasClientOnboardingService: true, client_since: '2026-01-10' }))).toBe(false)
  })

  it('client_since alone satisfies it even with no formation date', () => {
    expect(isMissingStartDate(f({ client_since: '2025-07-07' }))).toBe(false)
  })
})
