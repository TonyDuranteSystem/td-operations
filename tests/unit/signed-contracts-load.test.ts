import { describe, it, expect, beforeEach, vi } from 'vitest'

type Call = { table: string; columns: string; filters: Array<[string, string, unknown]> }

// the fake database is built in a hoisted block because vi.mock runs above the imports
const state = vi.hoisted(() => {
  const calls: Array<{ table: string; columns: string; filters: Array<[string, string, unknown]> }> = []
  const scripts: Record<string, unknown> = {}
  const answer = (call: { table: string; columns: string; filters: Array<[string, string, unknown]> }) => {
    const s = scripts[call.table]
    return typeof s === 'function' ? (s as (c: unknown) => unknown)(call) : s ?? { data: [], error: null }
  }
  function from(table: string) {
    const call = { table, columns: '', filters: [] as Array<[string, string, unknown]> }
    const done = () => {
      calls.push(call)
      return Promise.resolve(answer(call))
    }
    const chain: Record<string, unknown> = {
      select: (cols: string) => { call.columns = cols; return chain },
      eq: (c: string, v: unknown) => { call.filters.push(['eq', c, v]); return chain },
      ilike: (c: string, v: unknown) => { call.filters.push(['ilike', c, v]); return chain },
      in: (c: string, v: unknown) => { call.filters.push(['in', c, v]); return chain },
      order: () => chain,
      maybeSingle: () => done(),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => done().then(resolve, reject),
    }
    return chain
  }
  return { calls, scripts, from }
})
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: (t: string) => state.from(t) } }))

import { loadSignedContractEntry, loadSignedContractsForContact } from '@/lib/signed-contracts/load'

const offer = (id: string, token: string, type = 'formation') => ({ id, token, contract_type: type, installment_currency: 'USD', recurring_costs: null, account_id: null })
const contract = (id: string, token: string) => ({ id, offer_token: token, signed_at: '2026-06-01T10:00:00Z', created_at: '2026-06-01T10:00:00Z', updated_at: 'U', contract_version: null, annual_fee: '2000', installments: '{"jan":1000,"jun":1000}', pdf_path: `${token}/f.pdf` })

const callsOn = (table: string) => state.calls.filter((c) => c.table === table)

beforeEach(() => {
  state.calls.length = 0
  for (const k of Object.keys(state.scripts)) delete state.scripts[k]
})

describe('loadSignedContractsForContact — a failed lookup never hides a contract', () => {
  it('stops with the real cause when the company links cannot be read', async () => {
    state.scripts.account_contacts = { data: null, error: { message: 'links timed out' } }
    await expect(loadSignedContractsForContact('c1', 'a@x.com')).rejects.toThrow(/companies this person is linked to: links timed out/)
  })

  it('stops with the real cause when the leads cannot be read', async () => {
    state.scripts.leads = { data: null, error: { message: 'leads timed out' } }
    await expect(loadSignedContractsForContact('c1', 'a@x.com')).rejects.toThrow(/leads of this person: leads timed out/)
  })

  it('stops with the real cause when an offers query fails', async () => {
    state.scripts.offers = { data: null, error: { message: 'offers timed out' } }
    await expect(loadSignedContractsForContact('c1', 'a@x.com')).rejects.toThrow(/offers: offers timed out/)
  })

  it('stops when the signed contracts themselves cannot be read', async () => {
    state.scripts.offers = { data: [offer('o1', 't1')], error: null }
    state.scripts.contracts = { data: null, error: { message: 'contracts timed out' } }
    await expect(loadSignedContractsForContact('c1', null)).rejects.toThrow(/signed contracts: contracts timed out/)
  })
})

describe('loadSignedContractsForContact — which offers belong to a person', () => {
  it('looks through all four ways, and joins what they find', async () => {
    state.scripts.account_contacts = { data: [{ account_id: 'acc-1' }], error: null }
    state.scripts.leads = { data: [{ id: 'lead-1' }], error: null }
    state.scripts.offers = (c: Call) => {
      const f = c.filters[0]
      if (f[1] === 'contact_id') return { data: [offer('o1', 't1')], error: null }
      if (f[1] === 'client_email') return { data: [offer('o2', 't2'), offer('o1', 't1')], error: null } // o1 found twice: listed once
      if (f[1] === 'lead_id') return { data: [offer('o3', 't3')], error: null }
      return { data: [offer('o4', 't4', 'renewal')], error: null } // account_id
    }
    state.scripts.contracts = { data: [contract('k1', 't1'), contract('k2', 't2'), contract('k3', 't3'), contract('k4', 't4')], error: null }
    const entries = await loadSignedContractsForContact('c1', 'Mixed_Case@x.com')
    expect(entries.map((e) => e.id).sort()).toEqual(['k1', 'k2', 'k3', 'k4'])

    const offerQueries = callsOn('offers').map((c) => c.filters[0])
    expect(offerQueries).toContainEqual(['eq', 'contact_id', 'c1'])
    expect(offerQueries).toContainEqual(['in', 'lead_id', ['lead-1']])
    expect(offerQueries).toContainEqual(['in', 'account_id', ['acc-1']])
    // the email match ignores letter case, and "_" in an address is read as itself, not as "any character"
    expect(offerQueries).toContainEqual(['ilike', 'client_email', 'Mixed\\_Case@x.com'])
  })

  it('shows nothing, without an error, for a person with no offers at all', async () => {
    expect(await loadSignedContractsForContact('c1', null)).toEqual([])
    expect(callsOn('contracts').length).toBe(0)
  })
})

describe('loadSignedContractsForContact — what is read', () => {
  it('reads only the columns the card needs: never the passport, the address or any other personal field', async () => {
    state.scripts.offers = { data: [offer('o1', 't1')], error: null }
    state.scripts.contracts = { data: [contract('k1', 't1')], error: null }
    await loadSignedContractsForContact('c1', null)
    for (const c of [...callsOn('contracts'), ...callsOn('offers')]) {
      expect(c.columns).not.toContain('*')
      expect(c.columns).not.toMatch(/passport|address|phone|dob|birth|ssn|itin/i)
    }
    expect(callsOn('contracts')[0].columns).toBe('id, offer_token, signed_at, created_at, updated_at, contract_version, annual_fee, installments, pdf_path')
  })
})

describe('loadSignedContractEntry — answers with the line as it now stands', () => {
  it('says nothing when the signing does not exist', async () => {
    state.scripts.contracts = { data: null, error: null }
    expect(await loadSignedContractEntry('k1')).toBeNull()
  })

  it('throws, instead of answering "nothing", when a read fails', async () => {
    state.scripts.contracts = { data: null, error: { message: 'read failed' } }
    await expect(loadSignedContractEntry('k1')).rejects.toThrow(/signed contract: read failed/)

    state.scripts.contracts = { data: { offer_token: 't1' }, error: null }
    state.scripts.offers = { data: null, error: { message: 'offer read failed' } }
    await expect(loadSignedContractEntry('k1')).rejects.toThrow(/offer: offer read failed/)
  })

  it('returns the one line asked for', async () => {
    state.scripts.contracts = (c: Call) =>
      c.columns === 'offer_token' ? { data: { offer_token: 't1' }, error: null } : { data: [contract('k1', 't1')], error: null }
    state.scripts.offers = { data: [offer('o1', 't1')], error: null }
    const entry = await loadSignedContractEntry('k1')
    expect(entry?.id).toBe('k1')
    const filtered = callsOn('contracts').find((c) => c.columns !== 'offer_token')
    expect(filtered?.filters).toContainEqual(['eq', 'id', 'k1'])
  })
})
