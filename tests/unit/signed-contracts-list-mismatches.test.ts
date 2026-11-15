import { describe, it, expect } from 'vitest'
import { contractMismatchesByPerson, type OfferWithOwners } from '@/lib/signed-contracts/list-mismatches'
import { buildEntries, type ContractRow } from '@/lib/signed-contracts/entries'
import type { CompanyAmountsRow, CompanyLookup } from '@/lib/signed-contracts/company-check'

const company = (over: Partial<CompanyAmountsRow> = {}): CompanyAmountsRow => ({
  id: 'acc-1',
  installment_1_amount: 1000,
  installment_1_currency: 'USD',
  installment_2_amount: 1000,
  installment_2_currency: 'USD',
  ...over,
})
const lookup = (...rows: CompanyAmountsRow[]): CompanyLookup => ({ kind: 'ok', byId: new Map(rows.map((r) => [r.id, r])) })

const offer = (o: Partial<OfferWithOwners> & { token: string }): OfferWithOwners => ({
  id: `id-${o.token}`,
  contract_type: 'onboarding',
  installment_currency: 'USD',
  recurring_costs: null,
  account_id: 'acc-1',
  contact_id: null,
  client_email: null,
  lead_id: null,
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
const person = (over: Partial<{ id: string; email: string | null; accountIds: string[] }> = {}) => ({ id: 'p1', email: null, accountIds: [] as string[], ...over })

const run = (over: Partial<Parameters<typeof contractMismatchesByPerson>[0]>) =>
  contractMismatchesByPerson({
    people: [person()],
    leadPerson: new Map(),
    offers: [],
    contracts: [],
    companies: lookup(company()),
    companyNames: names,
    ...over,
  })

describe('contractMismatchesByPerson — the finding, in the words of the card', () => {
  it('the Xecom case: contract 1,175 + 1,175 against a company holding 1,000 + 1,000 flags the person with both sets of figures', () => {
    const out = run({ offers: [offer({ token: 't', contact_id: 'p1' })], contracts: [contract({ id: 'c', offer_token: 't' })] })
    expect(out.get('p1')).toEqual([
      {
        kind: 'differs',
        company: 'Xecom Consulting LLC',
        contract: 'Onboarding',
        contractAmounts: 'January $1,175 · June $1,175',
        crmAmounts: 'January $1,000 · June $1,000',
      },
    ])
  })

  it('flags nobody when the company agrees with the contract', () => {
    const out = run({
      offers: [offer({ token: 't', contact_id: 'p1' })],
      contracts: [contract({ id: 'c', offer_token: 't' })],
      companies: lookup(company({ installment_1_amount: 1175, installment_2_amount: 1175 })),
    })
    expect(out.size).toBe(0)
  })

  it('a company with no amounts saved is the other amber finding, with nothing to show from the CRM', () => {
    const out = run({
      offers: [offer({ token: 't', contact_id: 'p1' })],
      contracts: [contract({ id: 'c', offer_token: 't' })],
      companies: lookup(company({ installment_1_amount: null, installment_2_amount: null })),
    })
    expect(out.get('p1')).toEqual([
      { kind: 'company_empty', company: 'Xecom Consulting LLC', contract: 'Onboarding', contractAmounts: 'January $1,175 · June $1,175', crmAmounts: null },
    ])
  })

  it('every grey case flags nobody: no company on the offer, an unreadable contract, a failed lookup', () => {
    const base = { offers: [offer({ token: 't', contact_id: 'p1' })], contracts: [contract({ id: 'c', offer_token: 't' })] }
    expect(run({ ...base, offers: [offer({ token: 't', contact_id: 'p1', account_id: null })] }).size).toBe(0)
    expect(run({ ...base, contracts: [contract({ id: 'c', offer_token: 't', installments: 'garbage' })] }).size).toBe(0)
    expect(run({ ...base, companies: { kind: 'failed' } }).size).toBe(0)
  })

  it('a renewal is never flagged: its amounts are not compared', () => {
    const out = run({ offers: [offer({ token: 'r', contract_type: 'renewal', contact_id: 'p1' })], contracts: [contract({ id: 'c', offer_token: 'r' })] })
    expect(out.size).toBe(0)
  })

  it('only the newest signing of an offer counts: an older differing file is superseded by a newer matching one', () => {
    const out = run({
      offers: [offer({ token: 't', contact_id: 'p1' })],
      contracts: [
        contract({ id: 'old', offer_token: 't', created_at: '2026-03-01T00:00:00Z', installments: '{"jan":1175,"jun":1175}' }),
        contract({ id: 'new', offer_token: 't', created_at: '2026-04-01T00:00:00Z', installments: '{"jan":1000,"jun":1000}' }),
      ],
    })
    expect(out.size).toBe(0)
  })

  it('the company name falls back to a plain word when it is not known', () => {
    const out = run({ offers: [offer({ token: 't', contact_id: 'p1' })], contracts: [contract({ id: 'c', offer_token: 't' })], companyNames: new Map() })
    expect(out.get('p1')![0].company).toBe('The company')
  })
})

describe('contractMismatchesByPerson — a person owns a contract the same four ways the Contact page lists it', () => {
  const contracts = [contract({ id: 'c', offer_token: 't' })]

  it('the offer was made for them', () => {
    expect(run({ offers: [offer({ token: 't', contact_id: 'p1' })], contracts }).has('p1')).toBe(true)
    expect(run({ offers: [offer({ token: 't', contact_id: 'someone-else' })], contracts }).has('p1')).toBe(false)
  })

  it('the offer was sent to their email, whatever the letter case', () => {
    const o = offer({ token: 't', client_email: 'Gabriele.Sartori@Example.com' })
    expect(run({ people: [person({ email: 'gabriele.sartori@example.com' })], offers: [o], contracts }).has('p1')).toBe(true)
    expect(run({ people: [person({ email: 'other@example.com' })], offers: [o], contracts }).has('p1')).toBe(false)
    // a person with no email never matches an offer with no email
    expect(run({ people: [person({ email: null })], offers: [offer({ token: 't', client_email: null })], contracts }).has('p1')).toBe(false)
  })

  it('the offer was made from a lead that became them', () => {
    const o = offer({ token: 't', lead_id: 'lead-1' })
    expect(run({ offers: [o], contracts, leadPerson: new Map([['lead-1', 'p1']]) }).has('p1')).toBe(true)
    expect(run({ offers: [o], contracts, leadPerson: new Map([['lead-1', 'someone-else']]) }).has('p1')).toBe(false)
    expect(run({ offers: [o], contracts }).has('p1')).toBe(false)
  })

  it('the offer is filed on a company they are linked to — and so every person linked to it is flagged, as on the Contact page', () => {
    const o = offer({ token: 't', account_id: 'acc-1' })
    const out = run({ people: [person({ id: 'p1', accountIds: ['acc-1'] }), person({ id: 'p2', accountIds: ['acc-1'] }), person({ id: 'p3', accountIds: ['acc-2'] })], offers: [o], contracts })
    expect(Array.from(out.keys()).sort()).toEqual(['p1', 'p2'])
  })

  it('a person with several companies gets one finding per differing contract, ordered by company', () => {
    const out = run({
      people: [person({ accountIds: ['acc-1', 'acc-2'] })],
      offers: [offer({ token: 'a', account_id: 'acc-2' }), offer({ token: 'b', account_id: 'acc-1' })],
      contracts: [contract({ id: 'ca', offer_token: 'a' }), contract({ id: 'cb', offer_token: 'b' })],
      companies: lookup(company({ id: 'acc-1' }), company({ id: 'acc-2', installment_1_amount: 900, installment_2_amount: 900 })),
    })
    expect(out.get('p1')!.map((f) => [f.company, f.crmAmounts])).toEqual([
      ['Beta LLC', 'January $900 · June $900'],
      ['Xecom Consulting LLC', 'January $1,000 · June $1,000'],
    ])
  })

  it('the same contract found two ways is listed once', () => {
    const o = offer({ token: 't', contact_id: 'p1', account_id: 'acc-1', client_email: 'a@x.com' })
    const out = run({ people: [person({ email: 'a@x.com', accountIds: ['acc-1'] })], offers: [o], contracts })
    expect(out.get('p1')).toHaveLength(1)
  })
})

describe('contractMismatchesByPerson — the list and the Contact page cannot disagree', () => {
  it('flags exactly the offers the card draws amber, for the same inputs', () => {
    const offers = [
      offer({ token: 'differs', account_id: 'acc-1' }),
      offer({ token: 'matches', account_id: 'acc-2' }),
      offer({ token: 'nocompany', account_id: null }),
    ]
    const contracts = [contract({ id: 'c1', offer_token: 'differs' }), contract({ id: 'c2', offer_token: 'matches' }), contract({ id: 'c3', offer_token: 'nocompany' })]
    const companies = lookup(company({ id: 'acc-1' }), company({ id: 'acc-2', installment_1_amount: 1175, installment_2_amount: 1175 }))
    const card = buildEntries({ offers, contracts, agreements: [], corrections: [], companies })
    const amberOnCard = card.filter((e) => e.companyCheck?.state === 'differ' || e.companyCheck?.state === 'company_empty').map((e) => e.offerToken)

    const out = run({
      people: [person({ accountIds: ['acc-1', 'acc-2'], email: null }), person({ id: 'p2', accountIds: [] })],
      offers: offers.map((o) => ({ ...o, contact_id: o.account_id ? null : 'p1' })),
      contracts,
      companies,
    })
    expect(amberOnCard).toEqual(['differs'])
    expect(out.get('p1')!.map((f) => f.company)).toEqual(['Xecom Consulting LLC'])
    expect(out.has('p2')).toBe(false)
  })
})
