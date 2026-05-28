import { describe, it, expect } from 'vitest'
import { resolveSelectedEntity } from '@/lib/portal/select-entity'
import type { PortalAccount } from '@/lib/types'
import type { InProgressFormation } from '@/lib/portal/queries'

const acct = (id: string, tier: string | null): PortalAccount =>
  ({ id, company_name: `Co ${id}`, portal_tier: tier } as unknown as PortalAccount)

const formation = (sdId: string, label = 'New Co'): InProgressFormation =>
  ({ id: `formation:${sdId}`, sdId, label, stage: 'formation' })

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
})
