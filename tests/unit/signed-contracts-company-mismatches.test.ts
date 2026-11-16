import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

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

import { contractMismatchesByCompany, contractMismatchesByPerson } from '@/lib/signed-contracts/list-mismatches'
import { loadContractMismatchesForCompanies } from '@/lib/signed-contracts/load'
import type { ContractRow, OfferRow } from '@/lib/signed-contracts/entries'
import type { CompanyAmountsRow, CompanyLookup } from '@/lib/signed-contracts/company-check'
import type { ContractMismatch } from '@/lib/signed-contracts/types'
import { companyCard, contractAlert, PERSON_CARD_MAX_MISMATCHES } from '@/lib/crm-lists/hover-cards'
import { HoverCardBody } from '@/components/lists/hover-card'
import { ContractMismatchNote } from '@/components/accounts/contract-mismatch-note'

const company = (over: Partial<CompanyAmountsRow> = {}): CompanyAmountsRow => ({
  id: 'acc-1',
  installment_1_amount: 1000,
  installment_1_currency: 'USD',
  installment_2_amount: 1000,
  installment_2_currency: 'USD',
  ...over,
})
const lookup = (...rows: CompanyAmountsRow[]): CompanyLookup => ({ kind: 'ok', byId: new Map(rows.map((r) => [r.id, r])) })
const offer = (o: Partial<OfferRow> & { token: string }): OfferRow => ({
  id: `id-${o.token}`,
  contract_type: 'onboarding',
  installment_currency: 'USD',
  recurring_costs: null,
  account_id: 'acc-1',
  ...o,
})
const contract = (c: Partial<ContractRow> & { id: string; offer_token: string }): ContractRow => ({
  signed_at: '2026-03-26T16:19:17Z',
  created_at: '2026-03-26T16:19:17Z',
  updated_at: 'U',
  contract_version: null,
  annual_fee: '2350',
  installments: '{"jan":1175,"jun":1175}',
  pdf_path: `${c.offer_token}/c.pdf`,
  ...c,
})
const names = new Map([['acc-1', 'Xecom Consulting LLC'], ['acc-2', 'Beta LLC']])
const differsFinding: ContractMismatch = {
  kind: 'differs',
  company: 'Xecom Consulting LLC',
  contract: 'Onboarding',
  contractAmounts: 'January $1,175 · June $1,175',
  crmAmounts: 'January $1,000 · June $1,000',
}

const run = (over: Partial<Parameters<typeof contractMismatchesByCompany>[0]> = {}) =>
  contractMismatchesByCompany({
    accountIds: ['acc-1'],
    offers: [offer({ token: 't' })],
    contracts: [contract({ id: 'c', offer_token: 't' })],
    companies: lookup(company()),
    companyNames: names,
    ...over,
  })

describe('contractMismatchesByCompany — the company the contract is filed on is the one flagged', () => {
  it('the Xecom case: a contract of 1,175 + 1,175 filed on a company holding 1,000 + 1,000 flags that company with both sets of figures', () => {
    expect(run().get('acc-1')).toEqual([differsFinding])
  })

  it('flags nobody when the company agrees with the contract — the amber ends by itself once the amounts are corrected', () => {
    expect(run({ companies: lookup(company({ installment_1_amount: 1175, installment_2_amount: 1175 })) }).size).toBe(0)
  })

  it('a company with no amounts saved is the other amber finding', () => {
    const out = run({ companies: lookup(company({ installment_1_amount: null, installment_2_amount: null })) })
    expect(out.get('acc-1')).toEqual([{ ...differsFinding, kind: 'company_empty', crmAmounts: null }])
  })

  it('flags only the companies on the page', () => {
    expect(run({ accountIds: ['acc-2'] }).size).toBe(0)
    expect(run({ accountIds: [] }).size).toBe(0)
  })

  it('an offer filed on no company flags nobody (the card draws it grey, "not compared")', () => {
    expect(run({ offers: [offer({ token: 't', account_id: null })] }).size).toBe(0)
  })

  it('a company the lookup could not read flags nobody (the card says it could not compare, never "matches")', () => {
    expect(run({ companies: { kind: 'failed' } }).size).toBe(0)
  })

  it('a renewal agreement is never compared with the company', () => {
    expect(run({ offers: [offer({ token: 't', contract_type: 'renewal' })] }).size).toBe(0)
  })

  it('currency counts only when both sides state it', () => {
    // contract in EUR against a company in USD with the same figures is a difference; the same figures with no currency on the contract are not
    const eur = run({
      offers: [offer({ token: 't', installment_currency: 'EUR' })],
      companies: lookup(company({ installment_1_amount: 1175, installment_2_amount: 1175 })),
    })
    expect(eur.get('acc-1')?.[0].kind).toBe('differs')
  })

  it('two contracts on one company are both listed, sorted by contract', () => {
    const out = run({
      offers: [offer({ token: 'a', contract_type: 'onboarding' }), offer({ token: 'b', contract_type: 'formation' })],
      contracts: [contract({ id: 'ca', offer_token: 'a' }), contract({ id: 'cb', offer_token: 'b' })],
    })
    expect(out.get('acc-1')?.map((f) => f.contract)).toEqual(['Formation', 'Onboarding'])
  })

  it('agrees with the person side: the company that differs is the company on each flagged person\'s finding', () => {
    const offers = [offer({ token: 't', contact_id: 'p1' } as Partial<OfferRow> & { token: string })]
    const withOwners = offers.map((o) => ({ ...o, contact_id: 'p1', client_email: null, lead_id: null }))
    const contracts = [contract({ id: 'c', offer_token: 't' })]
    const byPerson = contractMismatchesByPerson({
      people: [{ id: 'p1', email: null, accountIds: [] }],
      leadPerson: new Map(),
      offers: withOwners,
      contracts,
      companies: lookup(company()),
      companyNames: names,
    })
    const byCompany = contractMismatchesByCompany({ accountIds: ['acc-1'], offers, contracts, companies: lookup(company()), companyNames: names })
    expect(byCompany.get('acc-1')).toEqual(byPerson.get('p1'))
  })
})

const dbOffer = (token: string, over: Record<string, unknown> = {}) => ({
  id: `id-${token}`, token, contract_type: 'onboarding', installment_currency: 'USD', recurring_costs: null, account_id: 'acc-1', ...over,
})
const dbContract = (id: string, token: string) => ({
  id, offer_token: token, signed_at: '2026-03-26T16:19:17Z', created_at: '2026-03-26T16:19:17Z', updated_at: 'U', contract_version: null,
  annual_fee: '2350', installments: '{"jan":1175,"jun":1175}', pdf_path: `${token}/f.pdf`,
})
const xecom = { id: 'acc-1', installment_1_amount: 1000, installment_1_currency: 'USD', installment_2_amount: 1000, installment_2_currency: 'USD' }
const callsOn = (table: string) => state.calls.filter((c) => c.table === table)

beforeEach(() => {
  state.calls.length = 0
  for (const k of Object.keys(state.scripts)) delete state.scripts[k]
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('loadContractMismatchesForCompanies — reads only what these companies need', () => {
  it('finds the company whose contract differs, and not a company that agrees', async () => {
    state.scripts.offers = { data: [dbOffer('t1')], error: null }
    state.scripts.contracts = { data: [dbContract('k1', 't1')], error: null }
    state.scripts.accounts = { data: [xecom], error: null }
    const out = await loadContractMismatchesForCompanies({ accountIds: ['acc-1', 'acc-2'], companyNames: names })
    expect(out.kind).toBe('ok')
    if (out.kind !== 'ok') return
    expect(out.byCompany.get('acc-1')).toEqual([differsFinding])
    expect(out.byCompany.has('acc-2')).toBe(false)
  })

  it('reads only formation and onboarding offers filed on these companies, with named columns only', async () => {
    state.scripts.offers = { data: [dbOffer('t1')], error: null }
    state.scripts.contracts = { data: [dbContract('k1', 't1')], error: null }
    state.scripts.accounts = { data: [xecom], error: null }
    await loadContractMismatchesForCompanies({ accountIds: ['acc-1'], companyNames: names })
    expect(callsOn('offers')[0].filters).toContainEqual(['in', 'account_id', ['acc-1']])
    expect(callsOn('offers')[0].filters).toContainEqual(['in', 'contract_type', ['formation', 'onboarding']])
    expect(callsOn('offers')[0].columns).not.toMatch(/\*|client_email/)
    // the personal columns of `contracts` (passport, address) are never selected
    expect(callsOn('contracts')[0].columns).not.toMatch(/passport|address|\*/i)
  })

  it('reads nothing at all when there is no company, and no contracts when the companies have no offer', async () => {
    expect(await loadContractMismatchesForCompanies({ accountIds: [], companyNames: names })).toEqual({ kind: 'ok', byCompany: new Map() })
    expect(state.calls).toHaveLength(0)
    state.scripts.offers = { data: [], error: null }
    expect(await loadContractMismatchesForCompanies({ accountIds: ['acc-1'], companyNames: names })).toEqual({ kind: 'ok', byCompany: new Map() })
    expect(callsOn('contracts')).toHaveLength(0)
  })

  it('asks for the offers a hundred companies at a time', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `acc-${i}`)
    await loadContractMismatchesForCompanies({ accountIds: ids, companyNames: names })
    const sizes = callsOn('offers').map((c) => (c.filters.find((f) => f[1] === 'account_id')?.[2] as string[]).length)
    expect(sizes.sort((a, b) => b - a)).toEqual([100, 100, 50])
  })

  it.each(['offers', 'contracts', 'accounts'])('a failed read of %s is reported as failed, never as "all fine"', async (table) => {
    state.scripts.offers = { data: [dbOffer('t1')], error: null }
    state.scripts.contracts = { data: [dbContract('k1', 't1')], error: null }
    state.scripts.accounts = { data: [xecom], error: null }
    state.scripts[table] = { data: null, error: { message: `${table} timed out` } }
    expect(await loadContractMismatchesForCompanies({ accountIds: ['acc-1'], companyNames: names })).toEqual({ kind: 'failed' })
  })
})

const cardSource = {
  company_name: 'Xecom Consulting LLC', entity_type: 'Single Member LLC', account_type: 'Client', status: 'Active', state_of_formation: 'NM',
  client_since: null, contact_name: null, contact_email: null, payment_overdue: 0,
  installment_1_amount: 1000, installment_1_currency: 'USD', installment_2_amount: 1000, installment_2_currency: 'USD',
  chip_1: { kind: 'not_invoiced' as const, count: 0 }, chip_2: { kind: 'not_invoiced' as const, count: 0 },
}

describe('companyCard — the amber block of a company card', () => {
  it('carries the finding without repeating the company name (it is the title)', () => {
    const card = companyCard({ ...cardSource, contract_mismatches: [differsFinding] }, 2026)
    expect(card.alert).toEqual({
      heading: 'Contract amounts differ from the company',
      blocks: [{ title: 'Onboarding contract', lines: ['Contract says: January $1,175 · June $1,175', 'Company in the CRM: January $1,000 · June $1,000'] }],
    })
  })

  it('has no alert key at all for a company with none (the card is unchanged)', () => {
    expect('alert' in companyCard(cardSource, 2026)).toBe(false)
    expect('alert' in companyCard({ ...cardSource, contract_mismatches: [] }, 2026)).toBe(false)
  })

  it('a long list is cut and points at the company, not the contact', () => {
    const many = Array.from({ length: PERSON_CARD_MAX_MISMATCHES + 2 }, () => differsFinding)
    const a = contractAlert(many, { forCompany: true })!
    expect(a.blocks[a.blocks.length - 1]).toEqual({ title: '+ 2 more', lines: ['Open the company to see them.'] })
  })

  it('the person wording is untouched by the company option', () => {
    expect(contractAlert([differsFinding])!.blocks[0].title).toBe('Xecom Consulting LLC · Onboarding contract')
  })

  it('is drawn on the hover card above the details', () => {
    const html = renderToStaticMarkup(createElement(HoverCardBody, { card: companyCard({ ...cardSource, contract_mismatches: [differsFinding] }, 2026) }))
    expect(html).toContain('data-testid="card-alert"')
    expect(html).toContain('Contract says: January $1,175 · June $1,175')
    expect(html).toContain('Company in the CRM: January $1,000 · June $1,000')
    expect(html.indexOf('card-alert')).toBeLessThan(html.indexOf('State'))
  })
})

describe('ContractMismatchNote — the amber note on the company page', () => {
  it('shows the heading, both sets of figures and what to do', () => {
    const html = renderToStaticMarkup(createElement(ContractMismatchNote, { findings: [differsFinding] }))
    expect(html).toContain('data-testid="contract-mismatch-note"')
    expect(html).toContain('amber')
    expect(html).toContain('Contract amounts differ from the company')
    expect(html).toContain('Contract says: January $1,175 · June $1,175')
    expect(html).toContain('Company in the CRM: January $1,000 · June $1,000')
    expect(html).toContain('Correct whichever one is wrong')
  })

  it('says the company has no amounts when that is the finding', () => {
    const html = renderToStaticMarkup(createElement(ContractMismatchNote, { findings: [{ ...differsFinding, kind: 'company_empty', crmAmounts: null }] }))
    expect(html).toContain('The company has no installment amounts saved in the CRM.')
  })

  it('draws nothing when there is nothing to check, and no button to hide it', () => {
    expect(renderToStaticMarkup(createElement(ContractMismatchNote, { findings: [] }))).toBe('')
    const html = renderToStaticMarkup(createElement(ContractMismatchNote, { findings: [differsFinding] }))
    expect(html).not.toContain('<button')
  })

  it('says so, in grey, when the check could not run (never silence as if all matched)', () => {
    const html = renderToStaticMarkup(createElement(ContractMismatchNote, { findings: null }))
    expect(html).toContain('data-testid="contract-mismatch-failed"')
    expect(html).toContain('Could not check the signed contract amounts just now')
    expect(html).not.toContain('amber')
  })
})
