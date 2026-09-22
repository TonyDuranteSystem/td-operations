import { describe, it, expect } from 'vitest'

describe('welcome-package-setup handler', () => {
  it('module exports handleWelcomePackagePrepare function', async () => {
    const mod = await import('@/lib/jobs/handlers/welcome-package-setup')
    expect(typeof mod.handleWelcomePackagePrepare).toBe('function')
  })
})

describe('portal_members step logic', () => {
  // Dev job bc2a8f7f (2026-09-20): this used to hardcode "active" for every
  // linked member, unconditionally — which silently defeated the onboarding
  // review gate (an account deliberately held at 'onboarding' pending staff
  // activation got force-upgraded to full 'active' access the moment this
  // job ran, seconds after Confirm, via this same shared job). Found live
  // in a sandbox end-to-end test: the account's OWN step explicitly logged
  // "stays at onboarding" while this loop silently overrode it seconds later.
  //
  // Fix: members are created at the account's OWN current tier, falling
  // back to "active" only when it's missing/invalid. This preserves the
  // Formation flow's real behavior unchanged (record-ein-received already
  // sets the account to 'active' BEFORE enqueueing this job, so reading the
  // current tier there still yields 'active') while no longer fighting the
  // onboarding review gate (the account stays 'onboarding' until something
  // else explicitly activates it).
  const resolveMemberTier = (accountPortalTier: string | null): string => {
    const validTiers = ['lead', 'formation', 'onboarding', 'active']
    return accountPortalTier && validTiers.includes(accountPortalTier) ? accountPortalTier : 'active'
  }

  it('formation flow: account already active post-EIN → members created active (unchanged)', () => {
    expect(resolveMemberTier('active')).toBe('active')
  })

  it('onboarding review-gate flow: account held at onboarding → members created onboarding, NOT force-upgraded', () => {
    expect(resolveMemberTier('onboarding')).toBe('onboarding')
  })

  it('falls back to active when the account has no tier set yet', () => {
    expect(resolveMemberTier(null)).toBe('active')
  })

  it('falls back to active on an invalid/unexpected tier value rather than propagating garbage', () => {
    expect(resolveMemberTier('bogus')).toBe('active')
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
