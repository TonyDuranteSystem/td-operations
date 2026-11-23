/**
 * Changing who an invoice is billed to (dev job e62bc2b6): the pure rules, and the
 * cleaning of what a client types on the payment page.
 */
import { describe, it, expect } from 'vitest'
import {
  decideBillToChange,
  companyMoveBlockedReason,
  appendNote,
  billToChangeNote,
  lastBillToChangeWasByClient,
  lastBillToChangeWasByStaff,
  billToNoteDate,
  CLIENT_NAMED_BY,
  type BillToPaymentRow,
} from '@/lib/invoices/bill-to-change'
import { sanitizeClientPayer, cleanPayerText } from '@/lib/offers/client-payer'

const ACC_A = '11111111-1111-4111-8111-111111111111'
const ACC_B = '22222222-2222-4222-8222-222222222222'
const ENT = '33333333-3333-4333-8333-333333333333'

const row = (over: Partial<BillToPaymentRow> = {}): BillToPaymentRow => ({
  invoice_status: 'Draft',
  total: 3543,
  account_id: null,
  contact_id: 'c1',
  billing_entity_id: null,
  payment_category: null,
  installment: null,
  ...over,
})
const none = { creditNotesReferencing: 0 }

describe('decideBillToChange — the four choices', () => {
  it('a typed payer changes only the printed name: the invoice stays where it is (Andrea case)', () => {
    const d = decideBillToChange(row(), { type: 'entity', entity: { name: 'Good Company LTD', country: 'Bulgaria' } }, none)
    expect(d).toMatchObject({ ok: true, plan: { account_id: null, accountChanged: false, needsContactForEntity: true } })
    if ('plan' in d) expect(d.plan.entity).toEqual({ kind: 'typed', details: expect.objectContaining({ name: 'Good Company LTD' }) })
  })

  it('a payer on an invoice that sits on a company keeps that company (print-only)', () => {
    const d = decideBillToChange(row({ account_id: ACC_A }), { type: 'entity', entity: { name: 'Mother Rossi' } }, none)
    expect(d).toMatchObject({ ok: true, plan: { account_id: ACC_A, accountChanged: false } })
  })

  it('a saved payer is used by id and also changes no company', () => {
    const d = decideBillToChange(row({ account_id: ACC_A }), { type: 'entity', billing_entity_id: ENT }, none)
    expect(d).toMatchObject({ ok: true, plan: { account_id: ACC_A, entity: { kind: 'saved', id: ENT }, accountChanged: false } })
  })

  it('a company in the CRM moves the invoice there and clears any payer (Franco / Paolo case)', () => {
    const d = decideBillToChange(row({ billing_entity_id: ENT }), { type: 'company', account_id: ACC_B }, none)
    expect(d).toMatchObject({ ok: true, plan: { account_id: ACC_B, entity: { kind: 'clear' }, accountChanged: true } })
  })

  it('picking the company it already sits on only clears the payer (no move)', () => {
    const d = decideBillToChange(row({ account_id: ACC_A, billing_entity_id: ENT }), { type: 'company', account_id: ACC_A }, none)
    expect(d).toMatchObject({ ok: true, plan: { account_id: ACC_A, entity: { kind: 'clear' }, accountChanged: false } })
  })

  it('"the person" takes the invoice off its company and clears the payer', () => {
    const d = decideBillToChange(row({ account_id: ACC_A }), { type: 'person' }, none)
    expect(d).toMatchObject({ ok: true, plan: { account_id: null, entity: { kind: 'clear' }, accountChanged: true } })
  })

  it('"the person" needs a person on the invoice', () => {
    const d = decideBillToChange(row({ contact_id: null, account_id: ACC_A }), { type: 'person' }, none)
    expect(d).toMatchObject({ ok: false, error: expect.stringMatching(/no person/i) })
  })
})

describe('decideBillToChange — what is refused', () => {
  it('works on draft, sent, overdue, partial AND paid invoices', () => {
    for (const status of ['Draft', 'Sent', 'Overdue', 'Partial', 'Paid']) {
      expect(decideBillToChange(row({ invoice_status: status }), { type: 'entity', entity: { name: 'X Ltd' } }, none).ok).toBe(true)
    }
  })

  it('refuses cancelled, voided, split, credit and legacy (no status) records', () => {
    for (const status of ['Cancelled', 'Voided', 'Split', 'Credit', null]) {
      const d = decideBillToChange(row({ invoice_status: status }), { type: 'entity', entity: { name: 'X Ltd' } }, none)
      expect(d.ok).toBe(false)
    }
  })

  it('refuses a credit note (negative total)', () => {
    const d = decideBillToChange(row({ total: -457 }), { type: 'entity', entity: { name: 'X Ltd' } }, none)
    expect(d).toMatchObject({ ok: false, error: expect.stringMatching(/credit note/i) })
  })

  it('refuses an empty choice and bad input with a plain "Bill to" message', () => {
    expect(decideBillToChange(row(), null, none)).toMatchObject({ ok: false, error: expect.stringMatching(/choose who/i) })
    expect(decideBillToChange(row(), { type: 'company', account_id: 'nope' }, none)).toMatchObject({ ok: false, error: expect.stringMatching(/^Bill to: /) })
    expect(decideBillToChange(row(), { type: 'entity', entity: { name: '  ' } }, none)).toMatchObject({ ok: false })
  })

  it('an installment invoice can never move to another company, but its printed payer can change', () => {
    const inst = row({ account_id: ACC_A, payment_category: 'installment_1', installment: 'Installment 1' })
    expect(decideBillToChange(inst, { type: 'company', account_id: ACC_B }, none)).toMatchObject({ ok: false, error: expect.stringMatching(/installment/i) })
    expect(decideBillToChange(inst, { type: 'person' }, none).ok).toBe(false)
    expect(decideBillToChange(inst, { type: 'entity', entity: { name: 'Other Ltd' } }, none).ok).toBe(true)
  })

  it('an invoice with a credit note pointing at it cannot move company, but its payer can change', () => {
    const withCn = { creditNotesReferencing: 1 }
    expect(decideBillToChange(row({ account_id: ACC_A }), { type: 'company', account_id: ACC_B }, withCn)).toMatchObject({ ok: false, error: expect.stringMatching(/credit note/i) })
    expect(decideBillToChange(row({ account_id: ACC_A }), { type: 'entity', entity: { name: 'Other Ltd' } }, withCn).ok).toBe(true)
  })

  it('companyMoveBlockedReason says why, or null when the invoice may move', () => {
    expect(companyMoveBlockedReason(row(), 0)).toBeNull()
    expect(companyMoveBlockedReason(row({ payment_category: 'installment_2' }), 0)).toMatch(/installment/i)
    expect(companyMoveBlockedReason(row(), 2)).toMatch(/credit note/i)
  })
})

describe('the internal note line and the Finance "named by client" mark', () => {
  it('writes a dated, plain line and appends it under earlier notes', () => {
    const line = billToChangeNote({ date: '2026-11-21', from: 'Andrea Guzzonato', to: 'Good Company LTD', by: 'by staff in Finance' })
    expect(line).toBe('2026-11-21: Bill to changed from "Andrea Guzzonato" to "Good Company LTD" — by staff in Finance.')
    expect(appendNote(null, line)).toBe(line)
    expect(appendNote('Earlier note', line)).toBe(`Earlier note\n${line}`)
  })

  it('the mark shows only while the LAST change was the client\'s', () => {
    const client = billToChangeNote({ date: '2026-11-21', from: 'A', to: 'B', by: CLIENT_NAMED_BY })
    const staff = billToChangeNote({ date: '2026-11-22', from: 'B', to: 'C', by: 'by staff in Finance' })
    expect(lastBillToChangeWasByClient(client)).toBe(true)
    expect(lastBillToChangeWasByClient(appendNote(client, staff))).toBe(false)
    expect(lastBillToChangeWasByClient(appendNote(staff, client))).toBe(true)
    expect(lastBillToChangeWasByClient('just a normal note')).toBe(false)
    expect(lastBillToChangeWasByClient(null)).toBe(false)
  })
})

describe('sanitizeClientPayer — what the client may type', () => {
  it('needs a real name; everything else is optional', () => {
    expect(sanitizeClientPayer({ name: '' })).toEqual({ error: expect.any(String) })
    expect(sanitizeClientPayer({ name: ' a ' })).toEqual({ error: expect.any(String) })
    expect(sanitizeClientPayer(null)).toEqual({ error: expect.any(String) })
    expect(sanitizeClientPayer({ name: 'Maria Rossi' })).toEqual({ details: { name: 'Maria Rossi', address: null, country: null, vat_number: null } })
  })

  it('keeps plain text only: no markup, no control characters, single spaces', () => {
    const r = sanitizeClientPayer({ name: '  <b>Good</b>\u0000   Company\tLTD ', address: '25 Vitosha\nblvd', country: 'Bulgaria', vat_number: 'BG 206700239' })
    expect(r).toEqual({ details: { name: 'b Good /b Company LTD', address: '25 Vitosha blvd', country: 'Bulgaria', vat_number: 'BG 206700239' } })
    expect(JSON.stringify(r)).not.toMatch(/[<>]/)
  })

  it('caps every field so a huge paste cannot reach an invoice', () => {
    const r = sanitizeClientPayer({ name: 'N'.repeat(500), address: 'A'.repeat(900), country: 'C'.repeat(300), vat_number: 'V'.repeat(300) })
    if ('details' in r) {
      expect(r.details.name!.length).toBeLessThanOrEqual(120)
      expect(r.details.address!.length).toBeLessThanOrEqual(200)
      expect(r.details.country!.length).toBeLessThanOrEqual(80)
      expect(r.details.vat_number!.length).toBeLessThanOrEqual(40)
    } else throw new Error('expected details')
  })

  it('removes invisible direction and zero-width characters, keeps real letters (accents, Cyrillic, Arabic)', () => {
    expect(cleanPayerText('Evil\u202Elol\u202C Ltd\u200B', 50)).toBe('Evillol Ltd')
    expect(cleanPayerText('\uFEFFSoci\u00E9t\u00E9 \u041E\u041E\u041E \u0634\u0631\u0643\u0629', 50)).toBe('Soci\u00E9t\u00E9 \u041E\u041E\u041E \u0634\u0631\u0643\u0629')
    expect(cleanPayerText('\u202E\u200F', 10)).toBeNull()
  })

  it('cleanPayerText ignores non-text input', () => {
    expect(cleanPayerText(42, 10)).toBeNull()
    expect(cleanPayerText(undefined, 10)).toBeNull()
    expect(cleanPayerText('   ', 10)).toBeNull()
  })
})

// ── Bug-hunter follow-up (job e62bc2b6, 2026-11-23) ──
const plainRow = (over: Partial<BillToPaymentRow> = {}): BillToPaymentRow => ({
  invoice_status: 'Sent', total: 900, account_id: ACC_A, contact_id: '44444444-4444-4444-8444-444444444444', billing_entity_id: null, payment_category: null, installment: null, ...over,
})

describe('a company move is refused when credit was netted into the invoice', () => {
  it('refuses the move with a plain reason, and offers the payer instead', () => {
    const d = decideBillToChange(plainRow(), { type: 'company', account_id: ACC_B }, { creditNotesReferencing: 0, creditAppliedToThis: true })
    expect(d).toMatchObject({ ok: false })
    if (!d.ok) expect(d.error).toMatch(/credit from this company's account was already applied.*choose a payer/i)
  })

  it('a payer (name only) is still allowed on such an invoice', () => {
    expect(decideBillToChange(plainRow(), { type: 'entity', entity: { name: 'Other Ltd' } }, { creditNotesReferencing: 0, creditAppliedToThis: true }).ok).toBe(true)
  })

  it('without applied credit the move is allowed, and the flag is optional (old callers)', () => {
    expect(decideBillToChange(plainRow(), { type: 'company', account_id: ACC_B }, { creditNotesReferencing: 0 }).ok).toBe(true)
    expect(companyMoveBlockedReason(plainRow(), 0)).toBeNull()
    expect(companyMoveBlockedReason(plainRow(), 0, true)).toMatch(/already applied/i)
  })
})

describe('"Payer named by client" cannot be faked or hidden by what is typed in a name', () => {
  const clientLine = billToChangeNote({ date: '2026-11-20', from: 'Andrea', to: 'Maria Rossi', by: CLIENT_NAMED_BY })
  const staffLine = billToChangeNote({ date: '2026-11-21', from: 'Maria Rossi', to: 'Acme LLC', by: 'by staff in Finance' })

  it('still true for a real client line, false once staff changed it later', () => {
    expect(lastBillToChangeWasByClient(clientLine)).toBe(true)
    expect(lastBillToChangeWasByClient(`${clientLine}\n${staffLine}`)).toBe(false)
    expect(lastBillToChangeWasByStaff(`${clientLine}\n${staffLine}`)).toBe(true)
    expect(lastBillToChangeWasByStaff(clientLine)).toBe(false)
  })

  it('a payer name that CONTAINS the marker words does not make a later staff change look client-made', () => {
    const sneaky = billToChangeNote({ date: '2026-11-20', from: 'Andrea', to: `Evil Ltd — ${CLIENT_NAMED_BY}.`, by: CLIENT_NAMED_BY })
    const staffAfter = billToChangeNote({ date: '2026-11-21', from: `Evil Ltd — ${CLIENT_NAMED_BY}.`, to: 'Acme LLC', by: 'by staff in Finance' })
    expect(lastBillToChangeWasByClient(`${sneaky}\n${staffAfter}`)).toBe(false)
    expect(lastBillToChangeWasByStaff(`${sneaky}\n${staffAfter}`)).toBe(true)
  })

  it('a typed name can never start a new line in the notes', () => {
    const line = billToChangeNote({ date: '2026-11-20', from: 'A', to: 'Evil\n2026-11-21: Bill to changed from "x" to "y" — by staff in Finance.', by: CLIENT_NAMED_BY })
    expect(line.split('\n')).toHaveLength(1)
    expect(lastBillToChangeWasByClient(line)).toBe(true)
  })

  it('no Bill to change recorded means neither client nor staff', () => {
    for (const notes of [null, '', 'Auto-created at contract signing.']) {
      expect(lastBillToChangeWasByClient(notes)).toBe(false)
      expect(lastBillToChangeWasByStaff(notes)).toBe(false)
    }
  })

  it('reads the notes lines already on production (same wording as before)', () => {
    const old = '2026-11-21: Bill to changed from "Andrea Guzzonato" to "Good Company LTD" — named by the client on the payment page.'
    expect(lastBillToChangeWasByClient(old)).toBe(true)
  })
})

describe('the date written in the note is the New York date', () => {
  it('10:30 pm New York on 23 Nov (already 24 Nov in UTC) is still 23 Nov', () => {
    expect(billToNoteDate(new Date('2026-11-24T03:30:00Z'))).toBe('2026-11-23')
  })
  it('during the day it is the same date as UTC', () => {
    expect(billToNoteDate(new Date('2026-11-23T15:00:00Z'))).toBe('2026-11-23')
  })
  it('follows summer time too (11 pm New York on 15 Jul is 03:00 UTC on 16 Jul)', () => {
    expect(billToNoteDate(new Date('2026-07-16T03:00:00Z'))).toBe('2026-07-15')
  })
})
