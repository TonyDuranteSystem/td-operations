import { describe, it, expect, vi, beforeEach } from 'vitest'

type Row = Record<string, unknown>
const tables: Record<string, Row[]> = {}

/** Tiny in-memory stand-in for the filters the lookup uses (select / in / eq / is / or / thenable). */
function from(table: string) {
  const filters: Array<(r: Row) => boolean> = []
  const q: Record<string, unknown> = {}
  q.select = () => q
  q.in = (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return q }
  q.eq = (col: string, v: unknown) => { filters.push((r) => r[col] === v); return q }
  q.is = (col: string, v: unknown) => { filters.push((r) => (r[col] ?? null) === v); return q }
  q.or = (expr: string) => {
    // The one expression the lookup sends for invoices.
    if (expr !== 'idempotency_key.like.offer-signed:%,tranche_offer_token.not.is.null') throw new Error('unexpected or(): ' + expr)
    filters.push((r) => String(r.idempotency_key ?? '').startsWith('offer-signed:') || r.tranche_offer_token != null)
    return q
  }
  q.then = (resolve: (v: { data: Row[]; error: null }) => unknown) =>
    resolve({ data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null })
  return q
}

vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: (t: string) => from(t) } }))

import { referrerNamesByOfferToken, referrerNamesByInvoice, signedOffersForAccounts, referredByForAccount } from '@/lib/referrals/referral-lookup'

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  tables.offers = [
    { token: 'ref-name', status: 'completed', account_id: 'A1', contact_id: 'P1', created_at: '2026-01-01', cost_summary: [{ total: '€3,000' }], referrer_name: 'Marco Rossi', referrer_account_id: null, referrer_contact_id: null },
    { token: 'ref-id-only', status: 'completed', account_id: 'A2', contact_id: 'P2', created_at: '2026-01-02', cost_summary: [{ total: '€2,500' }], referrer_name: null, referrer_account_id: 'A9', referrer_contact_id: null },
    { token: 'no-ref', status: 'completed', account_id: 'A3', contact_id: 'P3', created_at: '2026-01-03', cost_summary: [{ total: '€2,000' }], referrer_name: null, referrer_account_id: null, referrer_contact_id: null },
    { token: 'not-signed', status: 'viewed', account_id: 'A4', contact_id: 'P4', created_at: '2026-01-04', cost_summary: [{ total: '€9,000' }], referrer_name: 'Ghost', referrer_account_id: null, referrer_contact_id: null },
    // an offer made to a person, no company on it yet
    { token: 'person-only', status: 'completed', account_id: null, contact_id: 'P5', created_at: '2026-01-05', cost_summary: [{ total: '€3,500' }], referrer_name: 'Giulia Bianchi', referrer_account_id: null, referrer_contact_id: null },
    // an offer made to a person who owns TWO of the companies asked about
    { token: 'shared-person', status: 'completed', account_id: null, contact_id: 'P6', created_at: '2026-01-06', cost_summary: [{ total: '€1,111' }], referrer_name: 'Nobody', referrer_account_id: null, referrer_contact_id: null },
  ]
  tables.accounts = [{ id: 'A9', company_name: 'Referrer Co LLC' }]
  tables.contacts = [{ id: 'C9', full_name: 'Paolo Verdi' }]
  tables.account_contacts = [
    { account_id: 'A1', contact_id: 'P1' },
    { account_id: 'A5', contact_id: 'P5' },
    { account_id: 'A6', contact_id: 'P6' },
    { account_id: 'A7', contact_id: 'P6' },
    { account_id: 'A8', contact_id: 'P8' },
  ]
  tables.payments = [
    { account_id: 'A1', idempotency_key: 'offer-signed:ref-name', tranche_offer_token: null },
    { account_id: 'A10', idempotency_key: 'offer-signed:ref-name:3f2b8a52-6d1c-4c0a-9d77-1a2b3c4d5e6f', tranche_offer_token: null },
    { account_id: 'A11', idempotency_key: 'annual-installment:A11:2:2026', tranche_offer_token: null },
  ]
  tables.referrals = []
  tables.leads = []
})

describe('referrerNamesByOfferToken', () => {
  it('returns the typed name, resolves an id-only referrer, and leaves un-referred offers out', async () => {
    const map = await referrerNamesByOfferToken(['ref-name', 'ref-id-only', 'no-ref', 'missing'])
    expect(map.get('ref-name')).toBe('Marco Rossi')
    expect(map.get('ref-id-only')).toBe('Referrer Co LLC')
    expect(map.has('no-ref')).toBe(false)
    expect(map.has('missing')).toBe(false)
  })

  it('does nothing for an empty list', async () => {
    expect((await referrerNamesByOfferToken([])).size).toBe(0)
  })
})

describe('referrerNamesByInvoice', () => {
  it('tags the signing invoice (new and older key) and a plan part, and nothing else', async () => {
    const map = await referrerNamesByInvoice([
      { id: 'i1', idempotency_key: 'offer-signed:ref-name' },
      { id: 'i2', idempotency_key: 'offer-signed:ref-name:3f2b8a52-6d1c-4c0a-9d77-1a2b3c4d5e6f' },
      { id: 'i3', idempotency_key: 'offer-tranche:ref-name:2', tranche_offer_token: 'ref-name' },
      { id: 'i4', idempotency_key: 'offer-signed:no-ref' },
      { id: 'i5', idempotency_key: 'annual-installment:A1:2:2026' },
      { id: 'i6', idempotency_key: null },
    ])
    expect(Object.fromEntries(map)).toEqual({ i1: 'Marco Rossi', i2: 'Marco Rossi', i3: 'Marco Rossi' })
  })
})

describe('signedOffersForAccounts', () => {
  it('finds a company\'s signed offers through the offer, through its invoice, and through a person-only offer', async () => {
    const m = await signedOffersForAccounts(['A1', 'A5', 'A10', 'A3'])
    expect(m.get('A1')?.map((o) => o.token)).toEqual(['ref-name'])
    expect(m.get('A10')?.map((o) => o.token)).toEqual(['ref-name']) // reached only through its invoice
    expect(m.get('A5')?.map((o) => o.token)).toEqual(['person-only']) // offer had no company; person owns only A5
    expect(m.get('A3')?.map((o) => o.token)).toEqual(['no-ref'])
  })

  it('never lends one company\'s person-only offer to a person\'s other company', async () => {
    const m = await signedOffersForAccounts(['A6', 'A7'])
    expect(m.has('A6')).toBe(false)
    expect(m.has('A7')).toBe(false)
  })

  it('ignores offers that were not signed', async () => {
    const m = await signedOffersForAccounts(['A4'])
    expect(m.has('A4')).toBe(false)
  })
})

describe('referredByForAccount', () => {
  it('reads the referrer from the signed offer', async () => {
    expect(await referredByForAccount('A1')).toEqual(['Marco Rossi'])
    expect(await referredByForAccount('A2')).toEqual(['Referrer Co LLC'])
  })

  it('is empty for a company nobody referred', async () => {
    expect(await referredByForAccount('A3')).toEqual([])
    expect(await referredByForAccount('A4')).toEqual([])
  })

  it('covers a referral staff recorded by hand (no offer), by company', async () => {
    tables.referrals = [{ referrer_account_id: 'A9', referrer_contact_id: null, referred_account_id: 'A3', referred_contact_id: null, is_test: false }]
    expect(await referredByForAccount('A3')).toEqual(['Referrer Co LLC'])
  })

  it('covers a hand-recorded referral that names only the person, and skips test rows and self-referrals', async () => {
    tables.referrals = [
      { referrer_account_id: null, referrer_contact_id: 'C9', referred_account_id: null, referred_contact_id: 'P8', is_test: false },
      { referrer_account_id: 'A9', referrer_contact_id: null, referred_account_id: 'A8', referred_contact_id: null, is_test: true },
      { referrer_account_id: 'A8', referrer_contact_id: null, referred_account_id: 'A8', referred_contact_id: null, is_test: false },
    ]
    expect(await referredByForAccount('A8')).toEqual(['Paolo Verdi'])
  })

  it('falls back to the lead the person came from, only when nothing else is found', async () => {
    tables.leads = [{ converted_to_contact_id: 'P8', referrer_name: 'Lead Referrer', referrer_account_id: null, referrer_contact_id: null }]
    expect(await referredByForAccount('A8')).toEqual(['Lead Referrer'])
    // A1 already has the offer's referrer; the lead is not consulted.
    tables.leads = [{ converted_to_contact_id: 'P1', referrer_name: 'Someone Else', referrer_account_id: null, referrer_contact_id: null }]
    expect(await referredByForAccount('A1')).toEqual(['Marco Rossi'])
  })

  it('lists each name once even when the offer and a referral record agree', async () => {
    tables.referrals = [{ referrer_account_id: 'A9', referrer_contact_id: null, referred_account_id: 'A2', referred_contact_id: null, is_test: false }]
    expect(await referredByForAccount('A2')).toEqual(['Referrer Co LLC'])
  })
})
