/**
 * The single write path for "who is this invoice billed to" (dev job e62bc2b6), run on an
 * in-memory database: typed payer, company move (with the client's own copy following),
 * refusals, and the roll-back when the client's copy cannot be moved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { miniDb, type MiniDb } from './helpers/mini-db'

const h = vi.hoisted(() => ({ db: null as unknown as MiniDb }))
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: (t: string) => h.db.from(t) } }))

import { changeInvoiceBillTo } from '@/lib/operations/invoice-bill-to'

const ACC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ACC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const T0 = '2026-11-20T10:00:00.000Z'

type Row = Record<string, unknown>
const seed = (over: { payments?: Row[]; extra?: Record<string, Row[]> } = {}) => ({
  payments: over.payments ?? [
    { id: 'p1', invoice_number: 'INV-002820', invoice_status: 'Draft', total: 3543, account_id: null, contact_id: 'c1', billing_entity_id: null, payment_category: null, installment: null, notes: 'Auto-created at contract signing.', updated_at: T0 },
  ],
  contacts: [{ id: 'c1', full_name: 'Andrea Guzzonato' }, { id: 'c2', full_name: 'Someone Else' }],
  accounts: [{ id: ACC_A, company_name: 'Haxton Capital LLC' }, { id: ACC_B, company_name: 'Paolo Srl' }],
  account_contacts: [{ account_id: ACC_A, contact_id: 'c1', role: 'Owner', access_revoked_at: null }],
  billing_entities: [] as Row[],
  client_expenses: [{ id: 'e1', td_payment_id: 'p1', source: 'td_invoice', account_id: null, contact_id: 'c1' }],
  ...(over.extra ?? {}),
})

const pay = (id = 'p1') => h.db.tables.payments.find((p) => p.id === id)!
const typed = (name: string, extra: Row = {}) => ({ type: 'entity', entity: { name, ...extra } })

describe('changeInvoiceBillTo — a typed payer (Andrea case)', () => {
  beforeEach(() => { h.db = miniDb(seed()) })

  it('saves the payer for the invoice\'s person, prints it, keeps the person and company, and writes a note', async () => {
    const r = await changeInvoiceBillTo({ paymentId: 'p1', billTo: typed('Good Company LTD', { country: 'Bulgaria' }), by: 'by staff in Finance' })
    expect(r).toMatchObject({ invoiceNumber: 'INV-002820', from: 'Andrea Guzzonato', to: 'Good Company LTD', changed: true, accountChanged: false })
    const be = h.db.tables.billing_entities
    expect(be).toHaveLength(1)
    expect(be[0]).toMatchObject({ contact_id: 'c1', entity_name: 'Good Company LTD', country: 'Bulgaria' })
    expect(be[0].entity_type).toBeUndefined() // no type: nothing reads it (job 709ac868)
    expect(pay()).toMatchObject({ billing_entity_id: be[0].id, account_id: null, contact_id: 'c1', invoice_status: 'Draft', total: 3543 })
    expect(String(pay().notes)).toContain('Auto-created at contract signing.')
    expect(String(pay().notes)).toMatch(/Bill to changed from "Andrea Guzzonato" to "Good Company LTD" — by staff in Finance\./)
  })

  it('the same payer again changes nothing: no second payer row, no second note', async () => {
    await changeInvoiceBillTo({ paymentId: 'p1', billTo: typed('Good Company LTD', { country: 'Bulgaria' }), by: 'by staff in Finance' })
    const notes = pay().notes
    const r = await changeInvoiceBillTo({ paymentId: 'p1', billTo: typed('good company ltd', { country: 'bulgaria' }), by: 'by staff in Finance' })
    expect(r.changed).toBe(false)
    expect(h.db.tables.billing_entities).toHaveLength(1)
    expect(pay().notes).toBe(notes)
  })

  it('a person as payer (the mother case) works with just a name', async () => {
    const r = await changeInvoiceBillTo({ paymentId: 'p1', billTo: typed('Maria Guzzonato'), by: 'named by the client on the payment page' })
    expect(r.to).toBe('Maria Guzzonato')
    expect(String(pay().notes)).toContain('named by the client on the payment page')
    expect(pay().contact_id).toBe('c1') // the email recipient is untouched
  })

  it('works on a PAID invoice too, and does not touch its amounts or status', async () => {
    h.db = miniDb(seed({ payments: [{ id: 'p1', invoice_number: 'INV-002806', invoice_status: 'Paid', total: 2500, amount_paid: 2500, account_id: ACC_A, contact_id: 'c1', billing_entity_id: null, payment_category: null, installment: null, notes: null, updated_at: T0 }] }))
    const r = await changeInvoiceBillTo({ paymentId: 'p1', billTo: typed('Other Co Ltd'), by: 'by staff in Finance' })
    expect(r).toMatchObject({ from: 'Haxton Capital LLC', to: 'Other Co Ltd', accountChanged: false })
    expect(pay()).toMatchObject({ invoice_status: 'Paid', total: 2500, amount_paid: 2500, account_id: ACC_A })
  })

  it('an invoice with only a company (no person) hangs the payer on the company\'s owner', async () => {
    h.db = miniDb(seed({ payments: [{ id: 'p1', invoice_number: 'INV-1', invoice_status: 'Sent', total: 100, account_id: ACC_A, contact_id: null, billing_entity_id: null, payment_category: null, installment: null, notes: null, updated_at: T0 }] }))
    await changeInvoiceBillTo({ paymentId: 'p1', billTo: typed('Payer Ltd'), by: 'by staff in Finance' })
    expect(h.db.tables.billing_entities[0].contact_id).toBe('c1')
  })
})

describe('changeInvoiceBillTo — another company already in the CRM (Franco / Paolo case)', () => {
  beforeEach(() => { h.db = miniDb(seed()) })

  it('moves the invoice AND the client\'s own copy of it to that company', async () => {
    const r = await changeInvoiceBillTo({ paymentId: 'p1', billTo: { type: 'company', account_id: ACC_B }, by: 'by staff in Finance' })
    expect(r).toMatchObject({ from: 'Andrea Guzzonato', to: 'Paolo Srl', accountChanged: true })
    expect(pay()).toMatchObject({ account_id: ACC_B, billing_entity_id: null, contact_id: 'c1' })
    expect(h.db.tables.client_expenses[0]).toMatchObject({ account_id: ACC_B, contact_id: 'c1' })
  })

  it('moving from a payer to a company clears the payer', async () => {
    await changeInvoiceBillTo({ paymentId: 'p1', billTo: typed('Good Company LTD'), by: 'x' })
    await changeInvoiceBillTo({ paymentId: 'p1', billTo: { type: 'company', account_id: ACC_B }, by: 'x' })
    expect(pay()).toMatchObject({ account_id: ACC_B, billing_entity_id: null })
  })

  it('a company that is not in the CRM is refused and nothing changes', async () => {
    await expect(changeInvoiceBillTo({ paymentId: 'p1', billTo: { type: 'company', account_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }, by: 'x' })).rejects.toThrow(/not found in the CRM/i)
    expect(pay()).toMatchObject({ account_id: null, notes: 'Auto-created at contract signing.' })
    expect(h.db.tables.client_expenses[0].account_id).toBeNull()
  })

  it('if the client\'s copy cannot be moved, the invoice is put back exactly as it was', async () => {
    h.db = miniDb(seed(), { failOps: { 'client_expenses:update': 'boom' } })
    await expect(changeInvoiceBillTo({ paymentId: 'p1', billTo: { type: 'company', account_id: ACC_B }, by: 'x' })).rejects.toThrow(/nothing was changed/i)
    expect(pay()).toMatchObject({ account_id: null, billing_entity_id: null, notes: 'Auto-created at contract signing.' })
  })
})

describe('changeInvoiceBillTo — refusals', () => {
  it('refuses to move an installment invoice to another company, but lets its payer change', async () => {
    h.db = miniDb(seed({ payments: [{ id: 'p1', invoice_number: 'INV-2', invoice_status: 'Sent', total: 1000, account_id: ACC_A, contact_id: 'c1', billing_entity_id: null, payment_category: 'installment_1', installment: 'Installment 1', notes: null, updated_at: T0 }] }))
    await expect(changeInvoiceBillTo({ paymentId: 'p1', billTo: { type: 'company', account_id: ACC_B }, by: 'x' })).rejects.toThrow(/installment/i)
    await expect(changeInvoiceBillTo({ paymentId: 'p1', billTo: typed('Other Ltd'), by: 'x' })).resolves.toMatchObject({ changed: true })
  })

  it('refuses to move an invoice that a credit note points at', async () => {
    h.db = miniDb(seed({ payments: [
      { id: 'p1', invoice_number: 'INV-3', invoice_status: 'Sent', total: 500, account_id: ACC_A, contact_id: 'c1', billing_entity_id: null, payment_category: null, installment: null, notes: null, updated_at: T0 },
      { id: 'p9', invoice_number: 'CN-1', invoice_status: 'Credit', total: -50, credit_for_payment_id: 'p1', account_id: ACC_A, contact_id: 'c1', updated_at: T0 },
    ] }))
    await expect(changeInvoiceBillTo({ paymentId: 'p1', billTo: { type: 'company', account_id: ACC_B }, by: 'x' })).rejects.toThrow(/credit note/i)
  })

  it('refuses a saved payer that belongs to somebody else\'s person', async () => {
    h.db = miniDb(seed({ extra: { billing_entities: [{ id: '44444444-4444-4444-8444-444444444444', contact_id: 'c2', entity_name: 'Not Yours Ltd' }] } }))
    await expect(changeInvoiceBillTo({ paymentId: 'p1', billTo: { type: 'entity', billing_entity_id: '44444444-4444-4444-8444-444444444444' }, by: 'x' })).rejects.toThrow(/does not belong/i)
    expect(pay().billing_entity_id).toBeNull()
  })

  it('uses a saved payer of the invoice\'s own person', async () => {
    h.db = miniDb(seed({ extra: { billing_entities: [{ id: '55555555-5555-4555-8555-555555555555', contact_id: 'c1', entity_name: 'My Other Co' }] } }))
    const r = await changeInvoiceBillTo({ paymentId: 'p1', billTo: { type: 'entity', billing_entity_id: '55555555-5555-4555-8555-555555555555' }, by: 'x' })
    expect(r.to).toBe('My Other Co')
    expect(pay().billing_entity_id).toBe('55555555-5555-4555-8555-555555555555')
  })

  it('refuses a cancelled invoice and an unknown invoice', async () => {
    h.db = miniDb(seed({ payments: [{ id: 'p1', invoice_number: 'INV-4', invoice_status: 'Cancelled', total: 10, account_id: null, contact_id: 'c1', billing_entity_id: null, payment_category: null, installment: null, notes: null, updated_at: T0 }] }))
    await expect(changeInvoiceBillTo({ paymentId: 'p1', billTo: typed('X Ltd'), by: 'x' })).rejects.toThrow(/Cancelled/)
    await expect(changeInvoiceBillTo({ paymentId: 'nope', billTo: typed('X Ltd'), by: 'x' })).rejects.toThrow(/not found/i)
  })
})

// ── Bug-hunter pass (job e62bc2b6, 2026-11-22): what a move to another company must NOT change by accident ──
describe('changeInvoiceBillTo — an invoice with no person on it moves company (recipient pin)', () => {
  const noPerson = (over: Row = {}): Row => ({ id: 'p1', invoice_number: 'INV-9', invoice_status: 'Sent', total: 900, account_id: ACC_A, contact_id: null, billing_entity_id: null, payment_category: null, installment: null, notes: null, is_test: false, updated_at: T0, ...over })
  const people = [
    { id: 'c1', full_name: 'Franco Owner', email: 'franco@example.test' },
    { id: 'c2', full_name: 'Paolo Owner', email: 'paolo@example.test' },
  ]
  const links = [
    { account_id: ACC_A, contact_id: 'c1', role: 'Owner', access_revoked_at: null },
    { account_id: ACC_B, contact_id: 'c2', role: 'Owner', access_revoked_at: null },
  ]

  it('pins the old company\'s owner on the invoice, so the email does NOT switch to the new company\'s owner', async () => {
    h.db = miniDb(seed({ payments: [noPerson()], extra: { contacts: people, account_contacts: links } }))
    const r = await changeInvoiceBillTo({ paymentId: 'p1', billTo: { type: 'company', account_id: ACC_B }, by: 'by staff in Finance' })
    expect(r).toMatchObject({ accountChanged: true, emailKeptWith: 'Franco Owner' })
    expect(pay()).toMatchObject({ account_id: ACC_B, contact_id: 'c1' })
    expect(String(pay().notes)).toContain('the invoice email stays with Franco Owner')
  })

  it('does nothing of the kind when the invoice already has a person', async () => {
    h.db = miniDb(seed({ payments: [noPerson({ contact_id: 'c1' })], extra: { contacts: people, account_contacts: links } }))
    const r = await changeInvoiceBillTo({ paymentId: 'p1', billTo: { type: 'company', account_id: ACC_B }, by: 'x' })
    expect(r.emailKeptWith).toBeNull()
    expect(pay().contact_id).toBe('c1')
    expect(String(pay().notes)).not.toContain('email stays')
  })

  it('refuses when nobody at the old company has an email to keep sending to (the move would switch the recipient)', async () => {
    h.db = miniDb(seed({ payments: [noPerson()], extra: { contacts: [{ id: 'c1', full_name: 'No Email', email: null }, people[1]], account_contacts: links } }))
    await expect(changeInvoiceBillTo({ paymentId: 'p1', billTo: { type: 'company', account_id: ACC_B }, by: 'x' })).rejects.toThrow(/no person on it/i)
    expect(pay()).toMatchObject({ account_id: ACC_A, contact_id: null })
  })

  it('a payer (print-only) on a no-person invoice does not need a pin and leaves the recipient alone', async () => {
    h.db = miniDb(seed({ payments: [noPerson()], extra: { contacts: people, account_contacts: links } }))
    const r = await changeInvoiceBillTo({ paymentId: 'p1', billTo: typed('Payer Ltd'), by: 'x' })
    expect(r.emailKeptWith).toBeNull()
    expect(pay()).toMatchObject({ account_id: ACC_A, contact_id: null })
  })
})

describe('changeInvoiceBillTo — card autopay and the test flag follow the company', () => {
  const inv = (over: Row = {}): Row => ({ id: 'p1', invoice_number: 'INV-8', invoice_status: 'Sent', total: 400, account_id: ACC_A, contact_id: 'c1', billing_entity_id: null, payment_category: null, installment: null, notes: null, is_test: false, updated_at: T0, ...over })
  const accounts = (b: Row) => [{ id: ACC_A, company_name: 'Haxton Capital LLC', is_test: false, autopay_card_enabled: false }, { id: ACC_B, company_name: 'Paolo Srl', is_test: false, autopay_card_enabled: false, ...b }]

  it('refuses to move an UNPAID invoice into a company whose saved card is on autopay, and changes nothing', async () => {
    h.db = miniDb(seed({ payments: [inv()], extra: { accounts: accounts({ autopay_card_enabled: true }) } }))
    await expect(changeInvoiceBillTo({ paymentId: 'p1', billTo: { type: 'company', account_id: ACC_B }, by: 'x' })).rejects.toThrow(/automatic card payment/i)
    expect(pay()).toMatchObject({ account_id: ACC_A, notes: null })
    expect(h.db.tables.client_expenses[0].account_id).toBeNull()
  })

  it('a Draft is refused too (it can be sent, then charged); a PAID invoice may move there', async () => {
    h.db = miniDb(seed({ payments: [inv({ invoice_status: 'Draft' })], extra: { accounts: accounts({ autopay_card_enabled: true }) } }))
    await expect(changeInvoiceBillTo({ paymentId: 'p1', billTo: { type: 'company', account_id: ACC_B }, by: 'x' })).rejects.toThrow(/automatic card payment/i)
    h.db = miniDb(seed({ payments: [inv({ invoice_status: 'Paid' })], extra: { accounts: accounts({ autopay_card_enabled: true }) } }))
    await expect(changeInvoiceBillTo({ paymentId: 'p1', billTo: { type: 'company', account_id: ACC_B }, by: 'x' })).resolves.toMatchObject({ accountChanged: true })
  })

  it('a print-only payer is never blocked by autopay (the company does not change)', async () => {
    h.db = miniDb(seed({ payments: [inv()], extra: { accounts: accounts({ autopay_card_enabled: true }) } }))
    await expect(changeInvoiceBillTo({ paymentId: 'p1', billTo: typed('Payer Ltd'), by: 'x' })).resolves.toMatchObject({ changed: true })
  })

  it('moving into a TEST company makes the invoice a test invoice, on the invoice and on the client\'s copy', async () => {
    h.db = miniDb(seed({ payments: [inv()], extra: { accounts: accounts({ is_test: true }) } }))
    await changeInvoiceBillTo({ paymentId: 'p1', billTo: { type: 'company', account_id: ACC_B }, by: 'x' })
    expect(pay().is_test).toBe(true)
    expect(h.db.tables.client_expenses[0]).toMatchObject({ account_id: ACC_B, is_test: true })
  })

  it('moving out of a test company into a real one makes it a real invoice', async () => {
    h.db = miniDb(seed({ payments: [inv({ is_test: true })], extra: { accounts: accounts({}) } }))
    await changeInvoiceBillTo({ paymentId: 'p1', billTo: { type: 'company', account_id: ACC_B }, by: 'x' })
    expect(pay().is_test).toBe(false)
  })

  it('a print-only payer leaves the test flag alone', async () => {
    h.db = miniDb(seed({ payments: [inv({ is_test: true })], extra: { accounts: accounts({}) } }))
    await changeInvoiceBillTo({ paymentId: 'p1', billTo: typed('Payer Ltd'), by: 'x' })
    expect(pay().is_test).toBe(true)
  })

  it('a failed copy-move puts the test flag back too', async () => {
    h.db = miniDb(seed({ payments: [inv()], extra: { accounts: accounts({ is_test: true }) } }), { failOps: { 'client_expenses:update': 'boom' } })
    await expect(changeInvoiceBillTo({ paymentId: 'p1', billTo: { type: 'company', account_id: ACC_B }, by: 'x' })).rejects.toThrow(/nothing was changed/i)
    expect(pay()).toMatchObject({ account_id: ACC_A, is_test: false })
  })
})

describe('changeInvoiceBillTo — roll-back, with production\'s updated_at trigger (it stamps updated_at itself)', () => {
  const one = (): Row => ({ id: 'p1', invoice_number: 'INV-7', invoice_status: 'Sent', total: 100, account_id: null, contact_id: 'c1', billing_entity_id: null, payment_category: null, installment: null, notes: null, updated_at: T0 })

  it('a second change right after the first still works (it compares against the stamp the database gave)', async () => {
    h.db = miniDb(seed({ payments: [one()] }), { stampUpdatedAt: ['payments'] })
    await changeInvoiceBillTo({ paymentId: 'p1', billTo: typed('First Ltd'), by: 'x' })
    await expect(changeInvoiceBillTo({ paymentId: 'p1', billTo: typed('Second Ltd'), by: 'x' })).resolves.toMatchObject({ changed: true, to: 'Second Ltd' })
  })

  it('puts the invoice back when the client\'s copy fails — even though the database re-stamped updated_at', async () => {
    h.db = miniDb(seed({ payments: [one()] }), { stampUpdatedAt: ['payments'], failOps: { 'client_expenses:update': 'boom' } })
    await expect(changeInvoiceBillTo({ paymentId: 'p1', billTo: { type: 'company', account_id: ACC_B }, by: 'x' })).rejects.toThrow(/nothing was changed/i)
    expect(pay()).toMatchObject({ account_id: null, notes: null })
  })
})

describe('changeInvoiceBillTo — when even the roll-back cannot be done', () => {
  it('says so loudly instead of pretending nothing changed', async () => {
    const inner = miniDb(seed({ payments: [{ id: 'p1', invoice_number: 'INV-7', invoice_status: 'Sent', total: 100, account_id: null, contact_id: 'c1', billing_entity_id: null, payment_category: null, installment: null, notes: null, updated_at: T0 }] }), { stampUpdatedAt: ['payments'], failOps: { 'client_expenses:update': 'boom' } })
    // Somebody else touches the invoice right after our write: the undo (which only undoes OUR write) then matches nothing.
    h.db = { ...inner, from: (t: string) => { if (t === 'client_expenses') inner.tables.payments[0].updated_at = '2026-11-22T21:00:00.000000+00:00'; return inner.from(t) } }
    await expect(changeInvoiceBillTo({ paymentId: 'p1', billTo: { type: 'company', account_id: ACC_B }, by: 'x' })).rejects.toThrow(/putting the invoice back failed too/i)
  })
})
