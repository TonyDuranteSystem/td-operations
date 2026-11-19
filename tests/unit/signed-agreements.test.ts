/**
 * Dev job 0a60f416 — a signed short contract records WHICH agreements it contains, and every place that names a signed contract reads that
 * record first (Carasso: one offer for Company Closure + Tax Return was signed with only the Tax Return agreement and the CRM said "tax return").
 */
import { describe, it, expect } from 'vitest'
import { signPublicOffer, type SignDeps } from '@/lib/offers/sign-public-offer'
import { agreementsShownFor, parseSignedAgreements, shownDiffersFromPlan, signedAgreementsLabel } from '@/lib/offers/signed-agreements'
import { buildAccountContractLines } from '@/lib/signed-contracts/account-lines'
import { selectWithAgreements } from '@/lib/signed-contracts/contract-columns'

const closureAndTax = {
  token: 'carasso-2026',
  status: 'viewed',
  contract_type: 'tax_return',
  currency: 'USD',
  services: [
    { name: 'Company Closure', price: '$700', contract_type: 'closure' },
    { name: 'Tax Return 2026', price: '$500', contract_type: 'tax_return' },
  ],
  bank_details: { iban: 'X' },
  selected_services: [],
}

describe('agreementsShownFor — the plan the page draws', () => {
  it('switch OFF: only the offer\'s own type (the page as it always was)', () => {
    expect(agreementsShownFor(closureAndTax, 'tax_return', false)).toEqual([{ type: 'tax_return', name: 'Tax Return 2026' }])
  })
  it('switch ON: every bought line, in offer order', () => {
    expect(agreementsShownFor(closureAndTax, 'tax_return', true)).toEqual([
      { type: 'closure', name: 'Company Closure' },
      { type: 'tax_return', name: 'Tax Return 2026' },
    ])
  })
})

describe('shownDiffersFromPlan', () => {
  const planned = [{ type: 'closure', name: 'Company Closure' }, { type: 'tax_return', name: 'Tax Return 2026' }]
  it('same names in the same order = no difference', () => {
    expect(shownDiffersFromPlan(['Company Closure', 'Tax Return 2026'], planned)).toBe(false)
  })
  it('a page that printed fewer agreements than the server now plans differs (switch flipped while it was open)', () => {
    expect(shownDiffersFromPlan(['Tax Return 2026'], planned)).toBe(true)
  })
  it('a different order or name differs', () => {
    expect(shownDiffersFromPlan(['Tax Return 2026', 'Company Closure'], planned)).toBe(true)
    expect(shownDiffersFromPlan(['Company Closure', 'Tax Return 2025'], planned)).toBe(true)
  })
  it('a request without a list (an old tab during a deploy) is accepted', () => {
    expect(shownDiffersFromPlan(undefined, planned)).toBe(false)
    expect(shownDiffersFromPlan('Company Closure', planned)).toBe(false)
  })
})

describe('parseSignedAgreements / signedAgreementsLabel', () => {
  it('null, empty, malformed or non-list = no record (the old name is kept)', () => {
    for (const raw of [null, undefined, [], {}, 'nope', '[]', [{ name: 'x' }], [{ type: '' }], 7]) {
      expect(parseSignedAgreements(raw), JSON.stringify(raw)).toBeNull()
      expect(signedAgreementsLabel(raw), JSON.stringify(raw)).toBeNull()
    }
  })
  it('one agreement is named after its own type', () => {
    expect(signedAgreementsLabel([{ type: 'tax_return', name: 'Tax Return' }])).toEqual({ chip: 'Tax return', title: 'Tax Return Filing Agreement' })
    expect(signedAgreementsLabel([{ type: 'closure', name: 'Company Closure' }])?.title).toBe('Company Closure Service Agreement')
  })
  it('several agreements are named together, once per type, in the order signed', () => {
    expect(signedAgreementsLabel([{ type: 'closure', name: 'Company Closure' }, { type: 'tax_return', name: 'Tax Return 2026' }]))
      .toEqual({ chip: 'Closure + Tax return', title: 'Closure + Tax return agreements' })
    expect(signedAgreementsLabel([{ type: 'tax_return', name: 'a' }, { type: 'tax_return', name: 'b' }])?.title).toBe('Tax return agreements')
  })
  it('a record stored as JSON text is read too', () => {
    expect(signedAgreementsLabel(JSON.stringify([{ type: 'closure', name: 'x' }, { type: 'itin', name: 'y' }]))?.title).toBe('Closure + ITIN agreements')
  })
})

describe('the company page line is named from what the contract contains', () => {
  const offers = [{ token: 'carasso-2026', contract_type: 'tax_return' }, { token: 'old-2025', contract_type: 'tax_return' }]
  const base = { signed_at: '2026-11-19T08:38:22Z', created_at: '2026-11-19T08:38:22Z', pdf_path: 'x/y.pdf' }
  it('a contract with a record is named from it; one without keeps the old name — nothing is relabelled', () => {
    const lines = buildAccountContractLines({
      offers,
      contracts: [
        { id: 'c1', offer_token: 'carasso-2026', ...base, agreements: [{ type: 'closure', name: 'Company Closure' }, { type: 'tax_return', name: 'Tax Return 2026' }] },
        { id: 'c2', offer_token: 'old-2025', ...base, signed_at: '2026-01-05T10:00:00Z', agreements: null },
      ],
      agreementYears: {},
    })
    expect(lines.find((l) => l.id === 'c1')?.name).toBe('Closure + Tax return agreements')
    expect(lines.find((l) => l.id === 'c2')?.name).toBe('Tax Return Filing Agreement')
  })
})

describe('selectWithAgreements — a database without the column', () => {
  it('asks with the column; when the database does not know it, asks again without', async () => {
    const asked: string[] = []
    const r = await selectWithAgreements<string[]>(async (cols) => {
      asked.push(cols)
      return cols.includes('agreements') ? { data: null, error: { message: 'column contracts.agreements does not exist' } } : { data: ['row'], error: null }
    }, 'id, offer_token')
    expect(asked).toEqual(['id, offer_token, agreements', 'id, offer_token'])
    expect(r).toEqual({ data: ['row'], error: null })
  })
  it('any other error is returned as it is (never hidden)', async () => {
    const asked: string[] = []
    const r = await selectWithAgreements<string[]>(async (cols) => { asked.push(cols); return { data: null, error: { message: 'timeout' } } }, 'id')
    expect(asked).toHaveLength(1)
    expect(r.error?.message).toBe('timeout')
  })
})

function signWorld(opts: { multi: boolean; insertFailsOnColumn?: boolean; contractType?: string }) {
  const rows: Record<string, unknown>[] = []
  const deps: SignDeps = {
    storageObjectExists: async () => true,
    insertContract: async (row) => {
      if (opts.insertFailsOnColumn && 'agreements' in row) return { id: null, error: 'column "agreements" of relation "contracts" does not exist' }
      rows.push(row)
      return { id: 'c1', error: null }
    },
    deleteContract: async () => {},
    contractCount: async () => 0,
    flipOfferSigned: async () => ({ changed: 1, error: null }),
    processOfferSigned: async () => ({ status: 200, body: { ok: true } }),
    processAgreementSigned: async () => ({ status: 200, body: { ok: true } }),
    multiAgreementsEnabled: async () => opts.multi,
    now: () => new Date('2026-11-19T12:00:00Z'),
  }
  const offer = { ...closureAndTax, contract_type: opts.contractType ?? 'tax_return' }
  return { deps, rows, offer }
}
const PDF = 'carasso-2026/tax-agreement-signed-1.pdf'

describe('signing records what was printed', () => {
  it('switch ON, page printed both: the contract row records both agreements', async () => {
    const w = signWorld({ multi: true })
    const r = await signPublicOffer({ offer: w.offer, fields: {}, pdfPath: PDF, shownAgreements: ['Company Closure', 'Tax Return 2026'] }, w.deps)
    expect(r.error).toBeNull()
    expect(w.rows[0].agreements).toEqual([{ type: 'closure', name: 'Company Closure' }, { type: 'tax_return', name: 'Tax Return 2026' }])
  })
  it('switch OFF: the row records the single agreement the page printed', async () => {
    const w = signWorld({ multi: false })
    await signPublicOffer({ offer: w.offer, fields: {}, pdfPath: PDF, shownAgreements: ['Tax Return 2026'] }, w.deps)
    expect(w.rows[0].agreements).toEqual([{ type: 'tax_return', name: 'Tax Return 2026' }])
  })
  it('the switch was flipped ON while the page (printed with ONE agreement) was open: nothing is signed, the client is told to reload', async () => {
    const w = signWorld({ multi: true })
    const r = await signPublicOffer({ offer: w.offer, fields: {}, pdfPath: PDF, shownAgreements: ['Tax Return 2026'] }, w.deps)
    expect(r.status).toBe(409)
    expect(r.error).toMatch(/reload/i)
    expect(w.rows).toHaveLength(0)
  })
  it('the switch was flipped OFF while a two-agreement page was open: also refused', async () => {
    const w = signWorld({ multi: false })
    const r = await signPublicOffer({ offer: w.offer, fields: {}, pdfPath: PDF, shownAgreements: ['Company Closure', 'Tax Return 2026'] }, w.deps)
    expect(r.status).toBe(409)
    expect(w.rows).toHaveLength(0)
  })
  it('an old tab that sends no list still signs, recorded from the server\'s plan', async () => {
    const w = signWorld({ multi: false })
    const r = await signPublicOffer({ offer: w.offer, fields: {}, pdfPath: PDF }, w.deps)
    expect(r.error).toBeNull()
    expect(w.rows[0].agreements).toEqual([{ type: 'tax_return', name: 'Tax Return 2026' }])
  })
  it('a database that does not have the column yet still lets the client sign — without the record', async () => {
    const w = signWorld({ multi: true, insertFailsOnColumn: true })
    const r = await signPublicOffer({ offer: w.offer, fields: {}, pdfPath: PDF, shownAgreements: ['Company Closure', 'Tax Return 2026'] }, w.deps)
    expect(r.error).toBeNull()
    expect(w.rows).toHaveLength(1)
    expect('agreements' in w.rows[0]).toBe(false)
  })
  it('a formation / onboarding contract records nothing new', async () => {
    const w = signWorld({ multi: true, contractType: 'formation' })
    await signPublicOffer({ offer: w.offer, fields: {}, pdfPath: PDF }, w.deps)
    expect('agreements' in w.rows[0]).toBe(false)
  })
})

describe('the contact card names a contract from what it contains', () => {
  it('a contract with a record gets the combined name; one without keeps the name from the offer\'s main type', async () => {
    const { buildEntries } = await import('@/lib/signed-contracts/entries')
    const offers = [
      { id: 'o1', token: 'carasso-2026', contract_type: 'tax_return', installment_currency: null, recurring_costs: null, account_id: null },
      { id: 'o2', token: 'old-2025', contract_type: 'tax_return', installment_currency: null, recurring_costs: null, account_id: null },
    ]
    const base = { signed_at: '2026-11-19T08:38:22Z', created_at: '2026-11-19T08:38:22Z', updated_at: null, contract_version: null, annual_fee: null, installments: null, pdf_path: 'x/y.pdf' }
    const entries = buildEntries({
      offers,
      contracts: [
        { id: 'c1', offer_token: 'carasso-2026', ...base, agreements: [{ type: 'closure', name: 'Company Closure' }, { type: 'tax_return', name: 'Tax Return 2026' }] },
        { id: 'c2', offer_token: 'old-2025', ...base, agreements: null },
      ],
      agreements: [],
      corrections: [],
    })
    expect(entries.find((e) => e.id === 'c1')?.title).toBe('Closure + Tax return agreements')
    expect(entries.find((e) => e.id === 'c2')?.title).toBe('Tax Return Filing Agreement')
  })
})
