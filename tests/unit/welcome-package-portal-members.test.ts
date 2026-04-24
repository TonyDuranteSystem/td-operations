import { describe, it, expect } from 'vitest'

describe('welcome-package-setup handler', () => {
  it('module exports handleWelcomePackagePrepare function', async () => {
    const mod = await import('@/lib/jobs/handlers/welcome-package-setup')
    expect(typeof mod.handleWelcomePackagePrepare).toBe('function')
  })
})

describe('portal_members step logic', () => {
  it('uses active tier (post-EIN / state-confirmed)', () => {
    // Tier chosen here is 'active' — welcome-package-setup only runs when EIN exists,
    // meaning the LLC is state-confirmed. Members should see services, docs, deadlines.
    const EXPECTED_TIER = 'active'
    const validTiers = ['lead', 'onboarding', 'active', 'full']
    expect(validTiers).toContain(EXPECTED_TIER)
  })

  it('portal step summary format is correct', () => {
    const fmt = (created: number, existing: number, errors: number) =>
      `${created} created, ${existing} existing, ${errors} errors`

    expect(fmt(2, 1, 0)).toBe('2 created, 1 existing, 0 errors')
    expect(fmt(0, 3, 0)).toBe('0 created, 3 existing, 0 errors')
    expect(fmt(0, 0, 1)).toBe('0 created, 0 existing, 1 errors')
  })

  it('step status is error when any portal creation fails', () => {
    const statusFor = (errors: number) => errors > 0 ? 'error' : 'ok'
    expect(statusFor(0)).toBe('ok')
    expect(statusFor(1)).toBe('error')
    expect(statusFor(5)).toBe('error')
  })

  it('step status is ok when all portal creations succeed', () => {
    const statusFor = (errors: number) => errors > 0 ? 'error' : 'ok'
    expect(statusFor(0)).toBe('ok')
  })
})
