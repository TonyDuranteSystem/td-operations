import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { checkContractAgainstCompany, type CompanyAmountsRow, type CompanyLookup } from '@/lib/signed-contracts/company-check'
import { buildEntries, type ContractRow, type OfferRow } from '@/lib/signed-contracts/entries'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }))

import { CompanyCheckNote, SignedContractsCard } from '@/components/contacts/signed-contracts-card'

const company = (over: Partial<CompanyAmountsRow> = {}): CompanyAmountsRow => ({
  id: 'acc-1',
  installment_1_amount: 1175,
  installment_1_currency: 'USD',
  installment_2_amount: 1175,
  installment_2_currency: 'USD',
  ...over,
})
const lookup = (...rows: CompanyAmountsRow[]): CompanyLookup => ({ kind: 'ok', byId: new Map(rows.map((r) => [r.id, r])) })
const base = { january: 1175, june: 1175, unreadable: false, symbol: '$', accountId: 'acc-1' }

describe('checkContractAgainstCompany — the company agrees, or the note says exactly what it found', () => {
  it('says match when both amounts are the same', () => {
    expect(checkContractAgainstCompany({ ...base, lookup: lookup(company()) })).toEqual({ state: 'match' })
  })

  it('reads the company amounts whether the database hands back a number or a numeric string', () => {
    const c = company({ installment_1_amount: '1175.00', installment_2_amount: '1175' })
    expect(checkContractAgainstCompany({ ...base, lookup: lookup(c) })).toEqual({ state: 'match' })
  })

  it('the Xecom case: contract 1,175 + 1,175 against a company holding 1,000 + 1,000 differs, and shows the COMPANY figures', () => {
    const c = company({ installment_1_amount: 1000, installment_2_amount: 1000 })
    expect(checkContractAgainstCompany({ ...base, lookup: lookup(c) })).toEqual({ state: 'differ', january: '$1,000', june: '$1,000' })
  })

  it('differs when only one of the two installments differs', () => {
    const c = company({ installment_2_amount: 1000 })
    expect(checkContractAgainstCompany({ ...base, lookup: lookup(c) })).toEqual({ state: 'differ', january: '$1,175', june: '$1,000' })
  })

  it('shows a company amount as it is saved, never rounded', () => {
    const c = company({ installment_1_amount: 1000.5, installment_2_amount: 1000 })
    expect(checkContractAgainstCompany({ ...base, lookup: lookup(c) })).toEqual({ state: 'differ', january: '$1,000.5', june: '$1,000' })
  })

  it('a different currency is a difference even when the numbers are the same', () => {
    const c = company({ installment_1_currency: 'EUR', installment_2_currency: 'EUR' })
    expect(checkContractAgainstCompany({ ...base, lookup: lookup(c) })).toEqual({ state: 'differ', january: '€1,175', june: '€1,175' })
  })

  it('an unknown currency on either side is never guessed: same numbers still match', () => {
    expect(checkContractAgainstCompany({ ...base, symbol: '', lookup: lookup(company()) })).toEqual({ state: 'match' })
    const c = company({ installment_1_currency: null, installment_2_currency: null })
    expect(checkContractAgainstCompany({ ...base, lookup: lookup(c) })).toEqual({ state: 'match' })
  })

  it('says the company has nothing saved when either amount is empty or not a number', () => {
    expect(checkContractAgainstCompany({ ...base, lookup: lookup(company({ installment_1_amount: null })) })).toEqual({ state: 'company_empty' })
    expect(checkContractAgainstCompany({ ...base, lookup: lookup(company({ installment_2_amount: '' })) })).toEqual({ state: 'company_empty' })
    expect(checkContractAgainstCompany({ ...base, lookup: lookup(company({ installment_2_amount: 'abc' })) })).toEqual({ state: 'company_empty' })
  })

  it('does not compare an offer that is not filed on a company, or whose company is not found', () => {
    expect(checkContractAgainstCompany({ ...base, accountId: null, lookup: lookup(company()) })).toEqual({ state: 'no_company' })
    expect(checkContractAgainstCompany({ ...base, accountId: 'gone', lookup: lookup(company()) })).toEqual({ state: 'no_company' })
  })

  it('does not compare a contract whose own amounts cannot be read', () => {
    expect(checkContractAgainstCompany({ ...base, unreadable: true, lookup: lookup(company()) })).toEqual({ state: 'unreadable' })
    expect(checkContractAgainstCompany({ ...base, january: null, lookup: lookup(company()) })).toEqual({ state: 'unreadable' })
    expect(checkContractAgainstCompany({ ...base, june: null, lookup: lookup(company()) })).toEqual({ state: 'unreadable' })
  })

  it('a failed company lookup never says match and never says no company', () => {
    expect(checkContractAgainstCompany({ ...base, lookup: { kind: 'failed' } })).toEqual({ state: 'lookup_failed' })
  })
})

const offer = (o: Partial<OfferRow> & { token: string }): OfferRow => ({
  id: `id-${o.token}`, contract_type: 'formation', installment_currency: 'USD', recurring_costs: null, account_id: 'acc-1', ...o,
})
const contract = (c: Partial<ContractRow> & { id: string; offer_token: string }): ContractRow => ({
  signed_at: '2026-03-26T16:19:17Z', created_at: '2026-03-26T16:19:17Z', updated_at: 'U', contract_version: null,
  annual_fee: '2350', installments: '{"jan":1175,"jun":1175}', pdf_path: `${c.offer_token}/c.pdf`, ...c,
})

describe('buildEntries — which lines get a company check', () => {
  const run = (offers: OfferRow[], contracts: ContractRow[], companies?: CompanyLookup) =>
    buildEntries({ offers, contracts, agreements: [], corrections: [], companies })

  it('formation and onboarding lines carry the check', () => {
    const [f, o] = run(
      [offer({ token: 'f' }), offer({ token: 'o', contract_type: 'onboarding' })],
      [contract({ id: 'cf', offer_token: 'f', signed_at: '2026-03-02T00:00:00Z', created_at: '2026-03-02T00:00:00Z' }), contract({ id: 'co', offer_token: 'o', signed_at: '2026-03-01T00:00:00Z', created_at: '2026-03-01T00:00:00Z' })],
      lookup(company({ installment_1_amount: 1000, installment_2_amount: 1000 })),
    )
    expect(f.companyCheck).toEqual({ state: 'differ', january: '$1,000', june: '$1,000' })
    expect(o.companyCheck).toEqual({ state: 'differ', january: '$1,000', june: '$1,000' })
  })

  it('a line is marked unreadable, not compared, when its saved installments cannot be read', () => {
    const [e] = run([offer({ token: 'f' })], [contract({ id: 'c', offer_token: 'f', installments: 'garbage' })], lookup(company()))
    expect(e.companyCheck).toEqual({ state: 'unreadable' })
  })

  it('renewals, tax returns and other contracts are not compared', () => {
    const entries = run(
      [offer({ token: 'r', contract_type: 'renewal' }), offer({ token: 't', contract_type: 'tax_return' })],
      [contract({ id: 'cr', offer_token: 'r' }), contract({ id: 'ct', offer_token: 't', annual_fee: null, installments: null })],
      lookup(company()),
    )
    expect(entries.map((e) => e.companyCheck)).toEqual([null, null])
  })

  it('makes no comparison at all when the companies were not looked up', () => {
    const [e] = run([offer({ token: 'f' })], [contract({ id: 'c', offer_token: 'f' })])
    expect(e.companyCheck).toBeNull()
  })

  it('a failed lookup reaches the line as "could not compare"', () => {
    const [e] = run([offer({ token: 'f' })], [contract({ id: 'c', offer_token: 'f' })], { kind: 'failed' })
    expect(e.companyCheck).toEqual({ state: 'lookup_failed' })
  })

  it('an offer with no company says so on its line', () => {
    const [e] = run([offer({ token: 'f', account_id: null })], [contract({ id: 'c', offer_token: 'f' })], lookup(company()))
    expect(e.companyCheck).toEqual({ state: 'no_company' })
  })

  it('compares each line with ITS OWN company when a person has several', () => {
    const entries = run(
      [offer({ token: 'a', account_id: 'acc-1' }), offer({ token: 'b', account_id: 'acc-2' })],
      [
        contract({ id: 'ca', offer_token: 'a', signed_at: '2026-04-01T00:00:00Z', created_at: '2026-04-01T00:00:00Z' }),
        contract({ id: 'cb', offer_token: 'b', signed_at: '2026-03-01T00:00:00Z', created_at: '2026-03-01T00:00:00Z' }),
      ],
      lookup(company({ id: 'acc-1' }), company({ id: 'acc-2', installment_1_amount: 900, installment_2_amount: 900 })),
    )
    expect(entries.map((e) => [e.id, e.companyCheck?.state])).toEqual([['ca', 'match'], ['cb', 'differ']])
  })
})

describe('the card — what the note says', () => {
  const html = (check: Parameters<typeof CompanyCheckNote>[0]['check']) => renderToStaticMarkup(createElement(CompanyCheckNote, { check }))

  it('match is a quiet confirmation', () => {
    const h = html({ state: 'match' })
    expect(h).toContain('data-state="match"')
    expect(h).toContain('Matches the company’s installment amounts in the CRM.')
    expect(h).not.toContain('amber')
  })

  it('differ is amber and shows both company figures', () => {
    const h = html({ state: 'differ', january: '$1,000', june: '$1,000' })
    expect(h).toContain('data-state="differ"')
    expect(h).toContain('Differs from the company.')
    expect(h).toContain('January <b class="font-semibold">$1,000</b>')
    expect(h).toContain('amber')
  })

  it('an empty company is amber too', () => {
    const h = html({ state: 'company_empty' })
    expect(h).toContain('The company has no installment amounts saved')
    expect(h).toContain('amber')
  })

  it('the not-compared cases are grey and say Not compared / Could not compare', () => {
    expect(html({ state: 'no_company' })).toContain('Not compared: this offer is not filed on a company.')
    expect(html({ state: 'unreadable' })).toContain('Not compared: the amounts of this contract cannot be read as January and June.')
    const failed = html({ state: 'lookup_failed' })
    expect(failed).toContain('Could not compare with the company just now.')
    expect(failed).not.toContain('amber')
  })

  const entry = (check: Parameters<typeof CompanyCheckNote>[0]['check'] | null) => ({
    id: 'c1',
    offerToken: 'gabriele-sartori-2026',
    contractType: 'onboarding',
    chip: 'Onboarding',
    title: 'Master Service Agreement',
    signedAt: '2026-03-26T16:19:17Z',
    version: null,
    source: 'contract' as const,
    amounts: { kind: 'jan-jun' as const, january: '$1,175', june: '$1,175', yearly: '$2,350' },
    amountsEditable: true,
    editStart: { january: '1175', june: '1175' },
    symbol: '$',
    fileAvailable: true,
    correction: null,
    updatedAt: 'U',
    companyCheck: check,
  })
  const card = (check: Parameters<typeof CompanyCheckNote>[0]['check'] | null) =>
    renderToStaticMarkup(createElement(SignedContractsCard, { entries: [entry(check)], onEntryCorrected: () => {}, canEditAmounts: true }))

  it('the line on the Contact page shows the note under the saved amounts', () => {
    const h = card({ state: 'differ', january: '$1,000', june: '$1,000' })
    expect(h).toContain('January $1,175 · June $1,175 · yearly $2,350')
    expect(h).toContain('data-testid="company-check"')
    expect(h).toContain('$1,000')
  })

  it('a line that is not compared shows no note at all', () => {
    expect(card(null)).not.toContain('data-testid="company-check"')
  })
})
