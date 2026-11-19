import { describe, it, expect, beforeEach, vi } from 'vitest'

type Call = { table: string; filters: Array<[string, unknown, unknown?]> }
const calls: Call[] = []
const scripts: Record<string, { data: unknown; error: { message: string } | null }> = {}

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const call: Call = { table, filters: [] }
      calls.push(call)
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (c: string, v: unknown) => { call.filters.push([`eq ${c}`, v]); return chain },
        in: (c: string, v: unknown) => { call.filters.push([`in ${c}`, v]); return chain },
        ilike: (c: string, v: unknown) => { call.filters.push([`ilike ${c}`, v]); return chain },
        limit: () => chain,
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(scripts[table] ?? { data: [], error: null }).then(resolve, reject),
      }
      return chain
    },
  },
}))

import { loadBecameClientFacts } from '@/lib/accounts/became-client-load'

const ok = (data: unknown) => ({ data, error: null })

beforeEach(() => {
  calls.length = 0
  for (const k of Object.keys(scripts)) delete scripts[k]
})

describe('loadBecameClientFacts', () => {
  it('a signed formation contract: formation, with the New York day it was signed', async () => {
    scripts.offers = ok([{ token: 'T1', contract_type: 'formation' }])
    scripts.contracts = ok([{ offer_token: 'T1', signed_at: '2026-05-28T01:30:00+00:00' }]) // 9:30 pm May 27 in New York
    scripts.service_deliveries = ok([{ id: 'sd1' }])
    expect(await loadBecameClientFacts('acc-1', null)).toEqual({
      hasSignedFormationContract: true,
      hasSignedOnboardingContract: false,
      contractSignedAt: '2026-05-27',
      clientSince: null,
      hasFormationJob: true,
    })
  })

  it('looks up the offers of this account only, formation and onboarding only, and the contracts of those offers only', async () => {
    scripts.offers = ok([{ token: 'T1', contract_type: 'onboarding' }, { token: 'T2', contract_type: 'formation' }])
    await loadBecameClientFacts('acc-1', '2026-04-18')
    const offers = calls.find((c) => c.table === 'offers')!
    expect(offers.filters).toContainEqual(['eq account_id', 'acc-1'])
    expect(offers.filters).toContainEqual(['in contract_type', ['formation', 'onboarding']])
    expect(calls.find((c) => c.table === 'contracts')!.filters).toContainEqual(['in offer_token', ['T1', 'T2']])
    expect(calls.find((c) => c.table === 'service_deliveries')!.filters).toContainEqual(['eq account_id', 'acc-1'])
  })

  it('no offers: does not read contracts at all, and Client Since is passed through', async () => {
    const f = await loadBecameClientFacts('acc-1', '2026-04-18')
    expect(calls.some((c) => c.table === 'contracts')).toBe(false)
    expect(f).toEqual({
      hasSignedFormationContract: false,
      hasSignedOnboardingContract: false,
      contractSignedAt: null,
      clientSince: '2026-04-18',
      hasFormationJob: false,
    })
  })

  it('an offer that was never signed (no contract row) counts for nothing', async () => {
    scripts.offers = ok([{ token: 'T1', contract_type: 'formation' }])
    scripts.contracts = ok([])
    const f = await loadBecameClientFacts('acc-1', null)
    expect(f.hasSignedFormationContract).toBe(false)
    expect(f.contractSignedAt).toBeNull()
  })

  it('both kinds signed: both flags true and no single contract day', async () => {
    scripts.offers = ok([{ token: 'T1', contract_type: 'formation' }, { token: 'T2', contract_type: 'onboarding' }])
    scripts.contracts = ok([
      { offer_token: 'T1', signed_at: '2026-01-05T15:00:00+00:00' },
      { offer_token: 'T2', signed_at: '2026-03-09T15:00:00+00:00' },
    ])
    const f = await loadBecameClientFacts('acc-1', null)
    expect(f.hasSignedFormationContract && f.hasSignedOnboardingContract).toBe(true)
    expect(f.contractSignedAt).toBeNull()
  })

  it('several contracts of one kind: the earliest day', async () => {
    scripts.offers = ok([{ token: 'T1', contract_type: 'onboarding' }, { token: 'T2', contract_type: 'onboarding' }])
    scripts.contracts = ok([
      { offer_token: 'T1', signed_at: '2026-06-02T15:00:00+00:00' },
      { offer_token: 'T2', signed_at: '2026-02-12T15:00:00+00:00' },
    ])
    expect((await loadBecameClientFacts('acc-1', null)).contractSignedAt).toBe('2026-02-12')
  })

  it('a failed read throws with its real cause, for each of the three reads', async () => {
    scripts.offers = { data: null, error: { message: 'offers down' } }
    await expect(loadBecameClientFacts('acc-1', null)).rejects.toThrow('Could not read the offers: offers down')

    scripts.offers = ok([{ token: 'T1', contract_type: 'formation' }])
    scripts.contracts = { data: null, error: { message: 'contracts down' } }
    await expect(loadBecameClientFacts('acc-1', null)).rejects.toThrow('Could not read the signed contracts: contracts down')

    scripts.contracts = ok([])
    scripts.service_deliveries = { data: null, error: { message: 'jobs down' } }
    await expect(loadBecameClientFacts('acc-1', null)).rejects.toThrow('Could not read the service deliveries: jobs down')
  })
})
