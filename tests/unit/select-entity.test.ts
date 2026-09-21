import { describe, it, expect } from 'vitest'
import { resolveSelectedEntity } from '@/lib/portal/select-entity'
import type { PortalAccount } from '@/lib/types'
import type { InProgressFormation, InProgressOnboarding } from '@/lib/portal/queries'

const acct = (id: string, tier: string | null): PortalAccount =>
  ({ id, company_name: `Co ${id}`, portal_tier: tier } as unknown as PortalAccount)

const formation = (sdId: string, label = 'New Co'): InProgressFormation =>
  ({ id: `formation:${sdId}`, sdId, label, stage: 'formation' })

const onboarding = (leadId: string, label = 'New Onboarding Co'): InProgressOnboarding =>
  ({ id: `onboarding:${leadId}`, leadId, label, stage: 'onboarding' })

describe('resolveSelectedEntity', () => {
  it('no accounts, no formations → none + fallback tier', () => {
    expect(resolveSelectedEntity({ accounts: [], inProgress: [], fallbackTier: 'lead' }))
      .toEqual({ kind: 'none', tier: 'lead' })
  })

  it('single account → account selection at that account tier', () => {
    const r = resolveSelectedEntity({ accounts: [acct('a1', 'active')], inProgress: [], fallbackTier: 'lead' })
    expect(r.kind).toBe('account')
    expect(r.tier).toBe('active')
    if (r.kind === 'account') expect(r.accountId).toBe('a1')
  })

  it('account tier null → defaults to active (not the contact fallback)', () => {
    const r = resolveSelectedEntity({ accounts: [acct('a1', null)], inProgress: [], fallbackTier: 'lead' })
    expect(r.tier).toBe('active')
  })

  it('multiple accounts → cookie match wins', () => {
    const r = resolveSelectedEntity({
      accounts: [acct('a1', 'active'), acct('a2', 'onboarding')],
      inProgress: [], accountCookie: 'a2', fallbackTier: 'lead',
    })
    if (r.kind === 'account') { expect(r.accountId).toBe('a2'); expect(r.tier).toBe('onboarding') }
    else throw new Error('expected account')
  })

  it('multiple accounts, no/invalid cookie → first account', () => {
    const r = resolveSelectedEntity({
      accounts: [acct('a1', 'active'), acct('a2', 'onboarding')],
      inProgress: [], accountCookie: 'nope', fallbackTier: 'lead',
    })
    if (r.kind === 'account') expect(r.accountId).toBe('a1')
    else throw new Error('expected account')
  })

  it('formation cookie selects the in-progress formation (formation tier)', () => {
    const r = resolveSelectedEntity({
      accounts: [acct('a1', 'active')],
      inProgress: [formation('sd1', 'NM MMLLC')],
      formationCookie: 'formation:sd1', fallbackTier: 'lead',
    })
    expect(r.kind).toBe('formation')
    if (r.kind === 'formation') { expect(r.sdId).toBe('sd1'); expect(r.label).toBe('NM MMLLC'); expect(r.tier).toBe('formation') }
  })

  it('formation cookie wins even when an account exists (the multi-company switch)', () => {
    const r = resolveSelectedEntity({
      accounts: [acct('a1', 'active')],
      inProgress: [formation('sd1')],
      accountCookie: 'a1', formationCookie: 'formation:sd1', fallbackTier: 'lead',
    })
    expect(r.kind).toBe('formation')
  })

  it('stale/invalid formation cookie is ignored → falls back to account', () => {
    const r = resolveSelectedEntity({
      accounts: [acct('a1', 'active')],
      inProgress: [formation('sd1')],
      formationCookie: 'formation:GONE', fallbackTier: 'lead',
    })
    expect(r.kind).toBe('account')
  })

  it('no account but a formation in progress → defaults to the formation', () => {
    const r = resolveSelectedEntity({
      accounts: [], inProgress: [formation('sd1', 'Net-new Co')], fallbackTier: 'lead',
    })
    expect(r.kind).toBe('formation')
    if (r.kind === 'formation') expect(r.label).toBe('Net-new Co')
  })

  // ── Onboarding switcher entries (dev job bc2a8f7f, 2026-09-21) — the exact
  // same "returning client, second/new company" mechanism as formation above,
  // added after the sidebar's ever-present "Complete Setup" link and the
  // switcher were found to have no way to tell a second onboarding apart
  // from an existing account.

  it('onboarding cookie selects the in-progress onboarding (onboarding tier)', () => {
    const r = resolveSelectedEntity({
      accounts: [acct('a1', 'active')], inProgress: [],
      inProgressOnboardings: [onboarding('lead1', 'Marco Ventures LLC')],
      onboardingCookie: 'onboarding:lead1', fallbackTier: 'lead',
    })
    expect(r.kind).toBe('onboarding')
    if (r.kind === 'onboarding') { expect(r.leadId).toBe('lead1'); expect(r.label).toBe('Marco Ventures LLC'); expect(r.tier).toBe('onboarding') }
  })

  it('onboarding cookie wins even when an account exists (the multi-company switch, the exact hijack shape)', () => {
    const r = resolveSelectedEntity({
      accounts: [acct('a1', 'active')], inProgress: [],
      inProgressOnboardings: [onboarding('lead1')],
      accountCookie: 'a1', onboardingCookie: 'onboarding:lead1', fallbackTier: 'lead',
    })
    expect(r.kind).toBe('onboarding')
  })

  it('stale/invalid onboarding cookie is ignored → falls back to account', () => {
    const r = resolveSelectedEntity({
      accounts: [acct('a1', 'active')], inProgress: [],
      inProgressOnboardings: [onboarding('lead1')],
      onboardingCookie: 'onboarding:GONE', fallbackTier: 'lead',
    })
    expect(r.kind).toBe('account')
  })

  it('no account or formation but an onboarding in progress → defaults to the onboarding', () => {
    const r = resolveSelectedEntity({
      accounts: [], inProgress: [], inProgressOnboardings: [onboarding('lead1', 'Net-new Onboarding Co')],
      fallbackTier: 'lead',
    })
    expect(r.kind).toBe('onboarding')
    if (r.kind === 'onboarding') expect(r.label).toBe('Net-new Onboarding Co')
  })

  it('formation cookie takes precedence over onboarding cookie when somehow both are set (defensive)', () => {
    const r = resolveSelectedEntity({
      accounts: [], inProgress: [formation('sd1', 'Formation Co')],
      inProgressOnboardings: [onboarding('lead1', 'Onboarding Co')],
      formationCookie: 'formation:sd1', onboardingCookie: 'onboarding:lead1', fallbackTier: 'lead',
    })
    expect(r.kind).toBe('formation')
  })

  it('a real account still wins over a non-explicit in-progress onboarding (no cookie set)', () => {
    const r = resolveSelectedEntity({
      accounts: [acct('a1', 'active')], inProgress: [],
      inProgressOnboardings: [onboarding('lead1')],
      fallbackTier: 'lead',
    })
    expect(r.kind).toBe('account')
  })
})
