import { describe, it, expect, beforeEach, vi } from 'vitest'

type Call = { table: string; select: string; filters: Array<[string, unknown]> }
const calls: Call[] = []
const scripts: Record<string, { data: unknown; error: { message: string } | null }> = {}

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const call: Call = { table, select: '', filters: [] }
      calls.push(call)
      const chain: Record<string, unknown> = {
        select: (cols: string) => { call.select = cols; return chain },
        in: (c: string, v: unknown) => { call.filters.push([`in ${c}`, v]); return chain },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(scripts[table] ?? { data: [], error: null }).then(resolve, reject),
      }
      return chain
    },
  },
}))

import { loadSignedContractLinesForOffers } from '@/lib/signed-contracts/load-for-account'

const ok = (data: unknown) => ({ data, error: null })
beforeEach(() => {
  calls.length = 0
  for (const k of Object.keys(scripts)) delete scripts[k]
})

describe('loadSignedContractLinesForOffers', () => {
  it('no offers: reads nothing at all', async () => {
    expect(await loadSignedContractLinesForOffers([])).toEqual([])
    expect(calls.length).toBe(0)
  })

  it('reads the contracts of exactly these offers, and only the columns the line needs (never a passport, address or path column)', async () => {
    scripts.contracts = ok([{ id: 'c1', offer_token: 'T1', signed_at: '2026-02-12T15:00:00+00:00', created_at: '2026-02-12T15:00:01+00:00', pdf_path: 'T1/c.pdf' }])
    const lines = await loadSignedContractLinesForOffers([{ token: 'T1', contract_type: 'onboarding' }, { token: 'T2', contract_type: 'formation' }])
    const c = calls.find((x) => x.table === 'contracts')!
    expect(c.filters).toContainEqual(['in offer_token', ['T1', 'T2']])
    expect(c.select).toBe('id, offer_token, signed_at, created_at, pdf_path, agreements')
    expect(lines).toEqual([{ id: 'c1', name: 'Onboarding contract', signedOn: '2026-02-12', isMain: true, fileAvailable: true }])
  })

  it('no signed contract: no lines, and the annual agreements are not read', async () => {
    expect(await loadSignedContractLinesForOffers([{ token: 'T1', contract_type: 'renewal' }])).toEqual([])
    expect(calls.some((c) => c.table === 'annual_agreements')).toBe(false)
  })

  it('a signed renewal is named with its agreement year, read for that renewal only', async () => {
    scripts.contracts = ok([{ id: 'c1', offer_token: 'R1', signed_at: '2026-04-03T15:00:00+00:00', created_at: '2026-04-03T15:00:01+00:00', pdf_path: 'R1/c.pdf' }])
    scripts.annual_agreements = ok([{ token: 'R1', agreement_year: 2026 }])
    const lines = await loadSignedContractLinesForOffers([{ token: 'R1', contract_type: 'renewal' }, { token: 'R2', contract_type: 'renewal' }])
    expect(calls.find((c) => c.table === 'annual_agreements')!.filters).toContainEqual(['in token', ['R1']])
    expect(lines[0].name).toBe('Annual renewal agreement 2026')
  })

  it('a failed read throws with its real cause: a company that has a contract must never be shown "No signed contract"', async () => {
    scripts.contracts = { data: null, error: { message: 'contracts down' } }
    await expect(loadSignedContractLinesForOffers([{ token: 'T1', contract_type: 'onboarding' }])).rejects.toThrow('Could not read the signed contracts: contracts down')

    scripts.contracts = ok([{ id: 'c1', offer_token: 'R1', signed_at: '2026-04-03T15:00:00+00:00', created_at: null, pdf_path: 'x' }])
    scripts.annual_agreements = { data: null, error: { message: 'agreements down' } }
    await expect(loadSignedContractLinesForOffers([{ token: 'R1', contract_type: 'renewal' }])).rejects.toThrow('Could not read the annual agreements: agreements down')
  })
})
