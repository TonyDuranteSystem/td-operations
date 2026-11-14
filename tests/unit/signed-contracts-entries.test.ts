import { describe, it, expect } from 'vitest'
import {
  buildEntries,
  currencySymbolOf,
  hasUsablePath,
  newestPerOffer,
  type AgreementRow,
  type ContractRow,
  type CorrectionRow,
  type OfferRow,
} from '@/lib/signed-contracts/entries'

const offer = (o: Partial<OfferRow> & { token: string }): OfferRow => ({
  id: `id-${o.token}`, contract_type: 'formation', installment_currency: null, recurring_costs: null, account_id: null, ...o,
})
const contract = (c: Partial<ContractRow> & { id: string; offer_token: string }): ContractRow => ({
  signed_at: '2026-03-10T12:00:00Z', created_at: '2026-03-10T12:00:00Z', updated_at: '2026-03-10T12:00:00Z', contract_version: null,
  annual_fee: '2500', installments: '{"jan":1250,"jun":1250}', pdf_path: `${c.offer_token}/contract.pdf`, ...c,
})
const twoGroups = (a: string, b: string) => [
  { label: 'First Installment (January)', items: [{ name: 'Annual Management', price: a }], total: a },
  { label: 'Second Installment (June)', items: [{ name: 'Annual Management', price: b }], total: b },
]

describe('newestPerOffer', () => {
  it('lists only the newest file of an offer that was signed more than once', () => {
    const rows = [
      contract({ id: 'a1', offer_token: 'a', created_at: '2026-04-06T10:00:00Z' }),
      contract({ id: 'a2', offer_token: 'a', created_at: '2026-04-06T11:00:00Z' }),
      contract({ id: 'a3', offer_token: 'a', created_at: '2026-04-06T09:00:00Z' }),
      contract({ id: 'b1', offer_token: 'b', created_at: '2026-03-01T09:00:00Z' }),
    ]
    expect(newestPerOffer(rows).map((r) => r.id).sort()).toEqual(['a2', 'b1'])
  })
})

describe('buildEntries', () => {
  it('shows a formation contract with its saved amounts, newest signing first', () => {
    const entries = buildEntries({
      offers: [offer({ token: 'old', installment_currency: 'USD' }), offer({ token: 'new', contract_type: 'tax_return' })],
      contracts: [
        contract({ id: 'c-old', offer_token: 'old', signed_at: '2025-03-12T00:00:00Z', created_at: '2025-03-12T00:00:00Z' }),
        contract({ id: 'c-new', offer_token: 'new', signed_at: '2026-11-02T00:00:00Z', created_at: '2026-11-02T00:00:00Z', annual_fee: null, installments: null }),
      ],
      agreements: [],
      corrections: [],
    })
    expect(entries.map((e) => e.id)).toEqual(['c-new', 'c-old'])
    expect(entries[0]).toMatchObject({ chip: 'Tax return', title: 'Tax Return Filing Agreement', amounts: null, amountsEditable: false, editStart: null })
    expect(entries[1]).toMatchObject({
      chip: 'Formation',
      amounts: { kind: 'jan-jun', january: '$1,250', june: '$1,250', yearly: '$2,500' },
      amountsEditable: true,
      editStart: { january: '1250', june: '1250' },
      source: 'contract',
      symbol: '$',
      fileAvailable: true,
    })
  })

  it('a formation contract that saved nothing can still be edited, starting empty', () => {
    const [e] = buildEntries({ offers: [offer({ token: 't' })], contracts: [contract({ id: 'c', offer_token: 't', annual_fee: null, installments: null })], agreements: [], corrections: [] })
    expect(e.amounts).toEqual({ kind: 'jan-jun', january: 'nothing saved', june: 'nothing saved', yearly: null })
    expect(e.amountsEditable).toBe(true)
    expect(e.editStart).toEqual({ january: '', june: '' })
  })

  it('shows an Italian-style mis-save as it is, not tidied', () => {
    const [e] = buildEntries({
      offers: [offer({ token: 't', contract_type: 'onboarding' })],
      contracts: [contract({ id: 'c', offer_token: 't', annual_fee: '2.5001', installments: null })],
      agreements: [], corrections: [],
    })
    expect(e.amounts).toEqual({ kind: 'jan-jun', january: 'nothing saved', june: 'nothing saved', yearly: '2.5001' })
  })

  it('shows the glued wrong value as it is saved', () => {
    const [e] = buildEntries({
      offers: [offer({ token: 't' })],
      contracts: [contract({ id: 'c', offer_token: 't', annual_fee: '200010001000', installments: '{"jan":200010001000,"jun":0}' })],
      agreements: [], corrections: [],
    })
    expect(e.amounts).toEqual({ kind: 'jan-jun', january: '200,010,001,000', june: '0', yearly: '200,010,001,000' })
  })

  it('reads a renewal from the annual agreement, in the currency it was written in', () => {
    const offers = [offer({ token: 'r', contract_type: 'renewal' })]
    const agreements: AgreementRow[] = [{ token: 'r', agreement_year: 2026, cost_summary: twoGroups('$1,000', '$849'), updated_at: '2026-05-01T00:00:00Z' }]
    const [e] = buildEntries({ offers, contracts: [contract({ id: 'c', offer_token: 'r', annual_fee: null, installments: null })], agreements, corrections: [] })
    expect(e).toMatchObject({
      chip: 'Annual renewal',
      title: 'Annual renewal agreement 2026',
      source: 'agreement',
      amounts: { kind: 'jan-jun', january: '$1,000', june: '$849', yearly: null },
      amountsEditable: true,
      symbol: '$',
      updatedAt: '2026-05-01T00:00:00Z',
    })
    expect(e.editStart).toEqual({ january: '1000', june: '849' })
  })

  it('shows the saved lines of a renewal layout it cannot split, without an edit', () => {
    const odd = [{ label: 'Whatever', items: [{ name: 'Thing', price: '$5' }], total: '$5' }]
    const [e] = buildEntries({
      offers: [offer({ token: 'r', contract_type: 'renewal' })],
      contracts: [contract({ id: 'c', offer_token: 'r' })],
      agreements: [{ token: 'r', agreement_year: 2026, cost_summary: odd, updated_at: null }],
      corrections: [],
    })
    expect(e.amounts?.kind).toBe('lines')
    expect(e.amountsEditable).toBe(false)
  })

  it('a renewal with no agreement record says nothing is saved', () => {
    const [e] = buildEntries({ offers: [offer({ token: 'r', contract_type: 'renewal' })], contracts: [contract({ id: 'c', offer_token: 'r' })], agreements: [], corrections: [] })
    expect(e.amounts).toEqual({ kind: 'lines', lines: ['nothing saved'] })
    expect(e.amountsEditable).toBe(false)
  })

  it('greys out the button when no file is recorded', () => {
    const [e] = buildEntries({ offers: [offer({ token: 't' })], contracts: [contract({ id: 'c', offer_token: 't', pdf_path: null })], agreements: [], corrections: [] })
    expect(e.fileAvailable).toBe(false)
  })

  it('carries the last correction and the contract version', () => {
    const corrections: CorrectionRow[] = [
      { record_id: 'c', created_at: '2026-11-01T00:00:00Z', details: { by_name: 'Old', was_text: 'January 1' } },
      { record_id: 'c', created_at: '2026-11-13T00:00:00Z', details: { by_name: 'Antonio', was_text: 'January $1,000 · June $1,000' } },
      { record_id: 'other', created_at: '2026-11-14T00:00:00Z', details: { by_name: 'Nobody' } },
    ]
    const [e] = buildEntries({ offers: [offer({ token: 't' })], contracts: [contract({ id: 'c', offer_token: 't', contract_version: '2026-09-30' })], agreements: [], corrections })
    expect(e.version).toBe('2026-09-30')
    expect(e.correction).toEqual({ byName: 'Antonio', at: '2026-11-13T00:00:00Z', wasText: 'January $1,000 · June $1,000' })
  })

  it('skips a signing whose offer is unknown, and lists one line per offer', () => {
    const entries = buildEntries({
      offers: [offer({ token: 'known' })],
      contracts: [contract({ id: 'x', offer_token: 'unknown' }), contract({ id: 'k1', offer_token: 'known', created_at: '2026-01-01T00:00:00Z' }), contract({ id: 'k2', offer_token: 'known', created_at: '2026-01-02T00:00:00Z' })],
      agreements: [], corrections: [],
    })
    expect(entries.map((e) => e.id)).toEqual(['k2'])
  })

  it('never carries a passport number or an address into what the browser receives', () => {
    const risky = { ...contract({ id: 'c', offer_token: 't' }), client_passport: 'AB1234567', client_address: '1 Secret Street', client_phone: '+39 000' } as ContractRow
    const entries = buildEntries({ offers: [offer({ token: 't' })], contracts: [risky], agreements: [], corrections: [] })
    const json = JSON.stringify(entries)
    expect(json).not.toContain('AB1234567')
    expect(json).not.toContain('Secret Street')
    expect(json).not.toContain('+39')
    expect(json).not.toContain('contract.pdf') // not even the storage path
  })
})

describe('helpers', () => {
  it('only names a currency when the offer says which', () => {
    expect(currencySymbolOf({ installment_currency: 'USD', recurring_costs: null })).toBe('$')
    expect(currencySymbolOf({ installment_currency: 'EUR', recurring_costs: null })).toBe('€')
    expect(currencySymbolOf({ installment_currency: null, recurring_costs: [{ currency: 'USD', price: '$1000' }] })).toBe('$')
    expect(currencySymbolOf({ installment_currency: null, recurring_costs: [{ price: '€1.000' }] })).toBe('€')
    expect(currencySymbolOf({ installment_currency: null, recurring_costs: [{ price: '1000' }] })).toBe('')
    expect(currencySymbolOf({ installment_currency: null, recurring_costs: null })).toBe('')
  })

  it('only trusts a recorded path it could sign', () => {
    expect(hasUsablePath('abc/contract.pdf')).toBe(true)
    expect(hasUsablePath('/abc/contract.pdf')).toBe(true)
    expect(hasUsablePath('../x.pdf')).toBe(false)
    expect(hasUsablePath('a\\b.pdf')).toBe(false)
    expect(hasUsablePath('')).toBe(false)
    expect(hasUsablePath(null)).toBe(false)
  })
})
