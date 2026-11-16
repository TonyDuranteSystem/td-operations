import { describe, it, expect, beforeEach, vi } from 'vitest'

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
      in: (c: string, v: unknown) => { call.filters.push(['in', c, v]); return chain },
      order: () => chain,
      range: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => done().then(resolve, reject),
    }
    return chain
  }
  return { calls, scripts, from }
})
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: (t: string) => state.from(t) } }))

import { loadContractMismatchesForPeople } from '@/lib/signed-contracts/load'

const offer = (token: string, over: Record<string, unknown> = {}) => ({
  id: `id-${token}`, token, contract_type: 'onboarding', installment_currency: 'USD', recurring_costs: null, account_id: 'acc-1',
  contact_id: null, client_email: null, lead_id: null, ...over,
})
const contract = (id: string, token: string, installments = '{"jan":1175,"jun":1175}') => ({
  id, offer_token: token, signed_at: '2026-03-26T16:19:17Z', created_at: '2026-03-26T16:19:17Z', updated_at: 'U', contract_version: null,
  annual_fee: '2350', installments, pdf_path: `${token}/f.pdf`,
})
const xecom = { id: 'acc-1', installment_1_amount: 1000, installment_1_currency: 'USD', installment_2_amount: 1000, installment_2_currency: 'USD' }
const people = [{ id: 'p1', email: 'g@x.com', accountIds: ['acc-1'] }, { id: 'p2', email: null, accountIds: [] }]
const names = new Map([['acc-1', 'Xecom Consulting LLC']])
const callsOn = (table: string) => state.calls.filter((c) => c.table === table)

beforeEach(() => {
  state.calls.length = 0
  for (const k of Object.keys(state.scripts)) delete state.scripts[k]
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('loadContractMismatchesForPeople — one bulk read', () => {
  it('finds the person whose company holds other amounts than the contract, and nobody else', async () => {
    state.scripts.offers = { data: [offer('t1')], error: null }
    state.scripts.contracts = { data: [contract('k1', 't1')], error: null }
    state.scripts.accounts = { data: [xecom], error: null }
    const out = await loadContractMismatchesForPeople({ people, companyNames: names })
    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') return
    expect(out.byPerson.get('p1')).toEqual([
      { kind: 'differs', company: 'Xecom Consulting LLC', contract: 'Onboarding', contractAmounts: 'January $1,175 · June $1,175', crmAmounts: 'January $1,000 · June $1,000' },
    ])
    expect(out.byPerson.has('p2')).toBe(false)
  })

  it('reads only formation and onboarding offers, never renewals, and only the named columns of the offers and contracts', async () => {
    state.scripts.offers = { data: [offer('t1')], error: null }
    state.scripts.contracts = { data: [contract('k1', 't1')], error: null }
    state.scripts.accounts = { data: [xecom], error: null }
    await loadContractMismatchesForPeople({ people, companyNames: names })
    expect(callsOn('offers')[0].filters).toContainEqual(['in', 'contract_type', ['formation', 'onboarding']])
    expect(callsOn('offers')[0].columns).toContain('client_email')
    // the personal columns of `contracts` (passport, address) are never selected
    expect(callsOn('contracts')[0].columns).not.toMatch(/passport|address|\*/i)
  })

  it('looks up the leads of just the people on the page', async () => {
    state.scripts.offers = { data: [offer('t1', { account_id: null, lead_id: 'lead-1' })], error: null }
    state.scripts.leads = { data: [{ id: 'lead-1', converted_to_contact_id: 'p2' }], error: null }
    state.scripts.contracts = { data: [contract('k1', 't1')], error: null }
    state.scripts.accounts = { data: [xecom], error: null }
    await loadContractMismatchesForPeople({ people, companyNames: names })
    expect(callsOn('leads')[0].filters).toContainEqual(['in', 'converted_to_contact_id', ['p1', 'p2']])
  })

  it('asks for the contracts a hundred offers at a time', async () => {
    state.scripts.offers = { data: Array.from({ length: 250 }, (_, i) => offer(`t${i}`)), error: null }
    await loadContractMismatchesForPeople({ people, companyNames: names })
    const sizes = callsOn('contracts').map((c) => (c.filters[0][2] as string[]).length)
    expect(sizes.sort((a, b) => b - a)).toEqual([100, 100, 50])
  })

  it('reads the companies of the signed offers only', async () => {
    state.scripts.offers = { data: [offer('signed', { account_id: 'acc-1' }), offer('unsigned', { account_id: 'acc-9' })], error: null }
    state.scripts.contracts = { data: [contract('k1', 'signed')], error: null }
    state.scripts.accounts = { data: [xecom], error: null }
    await loadContractMismatchesForPeople({ people, companyNames: names })
    expect(callsOn('accounts')[0].filters).toContainEqual(['in', 'id', ['acc-1']])
  })

  it('reads nothing at all when there is nobody on the page', async () => {
    const out = await loadContractMismatchesForPeople({ people: [], companyNames: names })
    expect(out).toEqual({ kind: 'ok', byPerson: new Map() })
    expect(state.calls).toHaveLength(0)
  })
})

describe('loadContractMismatchesForPeople — a failed read is never an empty answer that looks like "all fine"', () => {
  it.each(['offers', 'leads', 'contracts', 'accounts'])('a failed read of %s is reported as failed', async (table) => {
    state.scripts.offers = { data: [offer('t1')], error: null }
    state.scripts.contracts = { data: [contract('k1', 't1')], error: null }
    state.scripts.accounts = { data: [xecom], error: null }
    state.scripts[table] = { data: null, error: { message: `${table} timed out` } }
    expect(await loadContractMismatchesForPeople({ people, companyNames: names })).toEqual({ kind: 'failed' })
  })
})
