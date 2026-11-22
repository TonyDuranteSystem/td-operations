/**
 * POST /api/offers/payer — "someone else is paying" on the client's payment page
 * (dev job e62bc2b6). The route is public (the offer's access code is the only key), so the
 * tests pin what it must REFUSE as much as what it saves.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { miniDb, type MiniDb } from './helpers/mini-db'

const h = vi.hoisted(() => ({
  db: null as unknown as MiniDb,
  access: null as unknown as Record<string, unknown>,
}))
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: (t: string) => h.db.from(t) } }))
vi.mock('@/lib/offers/public-offer-access', () => ({ resolvePublicOfferAccess: async () => h.access }))

import { POST } from '@/app/api/offers/payer/route'

type Row = Record<string, unknown>
const T0 = '2026-11-20T10:00:00.000Z'
const call = (body: Record<string, unknown>) =>
  POST(new NextRequest('http://localhost/api/offers/payer', { method: 'POST', body: JSON.stringify({ token: 'andrea-2026', code: 'abc', ...body }) }))
const json = async (res: Response) => (await res.json()) as Record<string, unknown>

const seed = (over: Record<string, Row[]> = {}) => ({
  offers: [{ token: 'andrea-2026', status: 'signed', bill_to: null }],
  pending_activations: [{ id: 'act1', offer_token: 'andrea-2026', portal_invoice_id: 'p1' }],
  payments: [{ id: 'p1', invoice_number: 'INV-002820', invoice_status: 'Draft', total: 3543, account_id: null, contact_id: 'c1', billing_entity_id: null, payment_category: null, installment: null, notes: null, updated_at: T0 }],
  contacts: [{ id: 'c1', full_name: 'Andrea Guzzonato' }],
  accounts: [] as Row[],
  account_contacts: [] as Row[],
  billing_entities: [] as Row[],
  client_expenses: [] as Row[],
  ...over,
})

beforeEach(() => {
  h.db = miniDb(seed())
  h.access = { error: null, status: 200, kind: 'offer', offer: { token: 'andrea-2026', status: 'signed' }, agreement: null, staffPreview: false }
})

describe('POST /api/offers/payer — set', () => {
  it('saves the typed payer on the invoice and on the offer, and the invoice stays with the signer', async () => {
    const res = await call({ action: 'set', payer: { name: 'Good Company LTD', address: '25 Vitosha blvd', country: 'Bulgaria', vat_number: 'BG206700239' } })
    expect(res.status).toBe(200)
    const inv = h.db.tables.payments[0]
    const be = h.db.tables.billing_entities
    expect(be).toHaveLength(1)
    expect(be[0]).toMatchObject({ contact_id: 'c1', entity_name: 'Good Company LTD', country: 'Bulgaria' })
    expect(inv).toMatchObject({ billing_entity_id: be[0].id, contact_id: 'c1', account_id: null, invoice_status: 'Draft' })
    expect(String(inv.notes)).toContain('named by the client on the payment page')
    expect(h.db.tables.offers[0].bill_to).toEqual({ type: 'entity', entity: expect.objectContaining({ name: 'Good Company LTD', country: 'Bulgaria' }) })
  })

  it('cleans what the client typed before it reaches an invoice', async () => {
    await call({ action: 'set', payer: { name: '<script>x</script> Mother  Rossi', address: 'Via Roma 1\n00100' } })
    const be = h.db.tables.billing_entities[0]
    expect(String(be.entity_name)).not.toMatch(/[<>]/)
    expect(be.billing_address).toBe('Via Roma 1 00100')
  })

  it('refuses once the invoice is paid, and changes nothing', async () => {
    h.db = miniDb(seed({ payments: [{ id: 'p1', invoice_number: 'INV-1', invoice_status: 'Paid', total: 10, account_id: null, contact_id: 'c1', billing_entity_id: null, notes: null, updated_at: T0 }] }))
    const res = await call({ action: 'set', payer: { name: 'Late Ltd' } })
    expect(res.status).toBe(409)
    expect(String((await json(res)).error)).toMatch(/already paid/i)
    expect(h.db.tables.billing_entities).toHaveLength(0)
    expect(h.db.tables.offers[0].bill_to).toBeNull()
  })

  it('refuses before the contract is signed', async () => {
    h.access = { ...h.access, offer: { token: 'andrea-2026', status: 'sent' } }
    const res = await call({ action: 'set', payer: { name: 'Early Ltd' } })
    expect(res.status).toBe(409)
    expect(h.db.tables.billing_entities).toHaveLength(0)
  })

  it('refuses a missing name with a plain message', async () => {
    const res = await call({ action: 'set', payer: { name: ' ' } })
    expect(res.status).toBe(400)
    expect(String((await json(res)).error)).toMatch(/name/i)
  })

  it('the client can only type a payer: a company id sent by hand is ignored', async () => {
    await call({ action: 'set', payer: { name: 'Typed Ltd', account_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type: 'company' } })
    expect(h.db.tables.payments[0].account_id).toBeNull()
    expect(h.db.tables.offers[0].bill_to).toEqual({ type: 'entity', entity: expect.objectContaining({ name: 'Typed Ltd' }) })
  })

  it('before any invoice exists it still records the payer on the offer for the invoice made later', async () => {
    h.db = miniDb(seed({ pending_activations: [] }))
    const res = await call({ action: 'set', payer: { name: 'Future Payer Ltd' } })
    expect(res.status).toBe(200)
    expect(h.db.tables.offers[0].bill_to).toEqual({ type: 'entity', entity: expect.objectContaining({ name: 'Future Payer Ltd' }) })
    expect(h.db.tables.billing_entities).toHaveLength(0)
  })

  it('refuses a request without the offer\'s access (error from the access check is passed through)', async () => {
    h.access = { error: 'Access denied', status: 403, kind: null, offer: null, agreement: null, staffPreview: false }
    const res = await call({ action: 'set', payer: { name: 'X Ltd' } })
    expect(res.status).toBe(403)
    expect(h.db.tables.billing_entities).toHaveLength(0)
  })

  it('is not available on a renewal agreement', async () => {
    h.access = { error: null, status: 200, kind: 'renewal', offer: null, agreement: { token: 'r1' }, staffPreview: false }
    const res = await call({ action: 'set', payer: { name: 'X Ltd' } })
    expect(res.status).toBe(400)
  })

  it('rejects an unknown action', async () => {
    expect((await call({ action: 'delete' })).status).toBe(400)
  })
})

describe('POST /api/offers/payer — get', () => {
  it('says who the invoice is addressed to now, and whether it can still be changed', async () => {
    await call({ action: 'set', payer: { name: 'Good Company LTD', country: 'Bulgaria' } })
    const res = await call({ action: 'get' })
    expect(await json(res)).toEqual({ ok: true, available: true, editable: true, payer: { name: 'Good Company LTD', address: null, country: 'Bulgaria', vat_number: null } })
  })

  it('an offer that is not signed yet is not available; a paid invoice is read-only', async () => {
    h.access = { ...h.access, offer: { token: 'andrea-2026', status: 'sent' } }
    expect((await json(await call({ action: 'get' }))).available).toBe(false)
    h.access = { ...h.access, offer: { token: 'andrea-2026', status: 'signed' } }
    h.db.tables.payments[0].invoice_status = 'Paid'
    expect((await json(await call({ action: 'get' }))).editable).toBe(false)
  })
})

describe('POST /api/offers/payer — company invoices and failures (bug-hunter pass, job e62bc2b6)', () => {
  const ACC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const onCompany = () => miniDb(seed({
    offers: [{ token: 'andrea-2026', status: 'signed', bill_to: null, account_id: ACC }],
    payments: [{ id: 'p1', invoice_number: 'INV-1', invoice_status: 'Draft', total: 100, account_id: ACC, contact_id: 'c1', billing_entity_id: null, payment_category: null, installment: null, notes: null, updated_at: T0 }],
    accounts: [{ id: ACC, company_name: 'Haxton Capital LLC' }],
    account_contacts: [{ account_id: ACC, contact_id: 'c1', role: 'Owner', access_revoked_at: null }],
  }))

  it('on an invoice that sits on a company the payer prints on that invoice, and the offer\'s own Invoice to is LEFT ALONE (later parts follow part 1)', async () => {
    h.db = onCompany()
    h.access = { ...h.access, offer: { token: 'andrea-2026', status: 'signed', bill_to: null, account_id: ACC, contact_id: 'c1' } }
    const res = await call({ action: 'set', payer: { name: 'Mother Rossi' } })
    expect(res.status).toBe(200)
    expect(h.db.tables.payments[0]).toMatchObject({ account_id: ACC, billing_entity_id: h.db.tables.billing_entities[0].id })
    expect(h.db.tables.offers[0].bill_to).toBeNull()
  })

  it('before any invoice exists, an offer made under a company also keeps its own Invoice to; an offer with no company records the payer', async () => {
    h.db = miniDb(seed({ pending_activations: [], offers: [{ token: 'andrea-2026', status: 'signed', bill_to: null, account_id: ACC }] }))
    h.access = { ...h.access, offer: { token: 'andrea-2026', status: 'signed', bill_to: null, account_id: ACC, contact_id: 'c1' } }
    await call({ action: 'set', payer: { name: 'Early Payer Ltd' } })
    expect(h.db.tables.offers[0].bill_to).toBeNull()
    h.db = miniDb(seed({ pending_activations: [] }))
    h.access = { ...h.access, offer: { token: 'andrea-2026', status: 'signed', bill_to: null, account_id: null, contact_id: 'c1' } }
    await call({ action: 'set', payer: { name: 'Early Payer Ltd' } })
    expect(h.db.tables.offers[0].bill_to).toEqual({ type: 'entity', entity: expect.objectContaining({ name: 'Early Payer Ltd' }) })
  })

  it('a database that cannot be read is an error answer — never "Saved", and nothing is written', async () => {
    for (const failing of ['pending_activations', 'payments']) {
      h.db = miniDb(seed(), { failing: { [failing]: 'db down' } })
      const res = await call({ action: 'set', payer: { name: 'Nobody Ltd' } })
      expect(res.status).toBe(500)
      expect(String((await json(res)).error)).toMatch(/could not load this right now/i)
      expect(h.db.tables.billing_entities ?? []).toHaveLength(0)
      expect(h.db.tables.offers[0].bill_to).toBeNull()
    }
  })

  it('"get" on an unreadable payer answers an error too, so the box hides itself instead of showing a blank payer', async () => {
    h.db = miniDb(seed({ payments: [{ id: 'p1', invoice_number: 'INV-1', invoice_status: 'Draft', total: 1, account_id: null, contact_id: 'c1', billing_entity_id: 'be1', notes: null, updated_at: T0 }] }), { failing: { billing_entities: 'db down' } })
    const res = await call({ action: 'get' })
    expect(res.status).toBe(500)
  })
})

