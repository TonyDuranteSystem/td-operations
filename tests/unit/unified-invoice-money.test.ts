/**
 * createUnifiedInvoice (discount / issue date / bank / next run date) and applyClientInvoicePayment (the one checked
 * payment writer). dev job 1a23f5f1, council review 2026-10-09.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDb, hasOp, opArgs, type Call } from './helpers/fake-supabase'

let fake = makeFakeDb(() => undefined)
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: (t: string) => fake.db.from(t) } }))
vi.mock('@/lib/portal/invoice-audit', () => ({ logInvoiceAudit: vi.fn() }))
vi.mock('@/lib/portal/invoice-number', () => ({ generateInvoiceNumber: vi.fn(async () => 'INV-000001'), isUniqueViolation: () => false }))
vi.mock('@/lib/portal/office-hours', () => ({ getOfficeDateString: () => '2026-10-09' }))

import { createUnifiedInvoice, applyClientInvoicePayment } from '@/lib/portal/unified-invoice'

function insertedInvoice(): Record<string, unknown> {
  const c = fake.calls.find(x => x.table === 'client_invoices' && x.ops.some(o => o.m === 'insert'))!
  return opArgs(c, 'insert')![0] as Record<string, unknown>
}

function createScript(c: Call) {
  if (c.table === 'client_invoices' && c.ops.some(o => o.m === 'insert')) return { data: { id: 'inv-1', invoice_number: 'INV-000001' } }
  return { data: [] }
}

describe('createUnifiedInvoice', () => {
  beforeEach(() => { fake = makeFakeDb(createScript) })
  const item = [{ description: 'Design', unit_price: 100, quantity: 2 }]

  it('saves the discount, the chosen issue date and the bank account (they used to be dropped)', async () => {
    await createUnifiedInvoice({ account_id: 'a', customer_id: 'c', line_items: item, discount: 50, issue_date: '2026-09-15', bank_account_id: 'bank-1' })
    const row = insertedInvoice()
    expect(row).toMatchObject({ subtotal: 200, discount: 50, total: 150, amount_due: 150, issue_date: '2026-09-15', bank_account_id: 'bank-1', status: 'Draft' })
  })
  it('defaults the issue date to today in the office timezone', async () => {
    await createUnifiedInvoice({ account_id: 'a', customer_id: 'c', line_items: item })
    expect(insertedInvoice().issue_date).toBe('2026-10-09')
  })
  it('ignores a malformed issue date', async () => {
    await createUnifiedInvoice({ account_id: 'a', customer_id: 'c', line_items: item, issue_date: 'yesterday' })
    expect(insertedInvoice().issue_date).toBe('2026-10-09')
  })
  it('never lets the discount push the total below zero', async () => {
    await createUnifiedInvoice({ account_id: 'a', customer_id: 'c', line_items: item, discount: 9999 })
    expect(insertedInvoice()).toMatchObject({ discount: 200, total: 0 })
  })
  it('a zero-total invoice stays a Draft (it used to be born Paid and could not be sent)', async () => {
    await createUnifiedInvoice({ account_id: 'a', customer_id: 'c', line_items: [{ description: 'Free', unit_price: 0 }] })
    expect(insertedInvoice().status).toBe('Draft')
  })
  it('rounds money to cents', async () => {
    await createUnifiedInvoice({ account_id: 'a', customer_id: 'c', line_items: [{ description: 'x', unit_price: 33.37, quantity: 3 }] })
    expect(insertedInvoice()).toMatchObject({ subtotal: 100.11, total: 100.11 })
  })
  it('a recurring invoice gets its NEXT run date written, or it would never run', async () => {
    await createUnifiedInvoice({ account_id: 'a', customer_id: 'c', line_items: item, issue_date: '2026-01-31', recurring_frequency: 'monthly' })
    expect(insertedInvoice()).toMatchObject({ recurring_frequency: 'monthly', recurring_next_date: '2026-02-28' })
  })
  it('a one-off invoice has no run date; a generated copy never gets a schedule of its own', async () => {
    await createUnifiedInvoice({ account_id: 'a', customer_id: 'c', line_items: item })
    expect(insertedInvoice().recurring_next_date).toBeNull()
    fake = makeFakeDb(createScript)
    await createUnifiedInvoice({ account_id: 'a', customer_id: 'c', line_items: item, recurring_frequency: 'monthly', recurring_parent_id: 'tpl' })
    expect(insertedInvoice().recurring_next_date).toBeNull()
  })
  it('removes the invoice again if its lines cannot be saved (no empty invoices)', async () => {
    fake = makeFakeDb(c => {
      if (c.table === 'client_invoices' && c.ops.some(o => o.m === 'insert')) return { data: { id: 'inv-1', invoice_number: 'INV-000001' } }
      if (c.table === 'client_invoice_items') return { error: { message: 'nope' } }
      return { data: [] }
    })
    await expect(createUnifiedInvoice({ account_id: 'a', customer_id: 'c', line_items: item })).rejects.toThrow(/lines/)
    expect(fake.calls.some(c => c.table === 'client_invoices' && c.ops.some(o => o.m === 'delete'))).toBe(true)
  })
})

describe('applyClientInvoicePayment', () => {
  function dbWith(row: Record<string, unknown> | null, written: boolean | { error: string } = true) {
    fake = makeFakeDb(c => {
      if (c.ops.some(o => o.m === 'maybeSingle')) return { data: row }
      if (c.ops.some(o => o.m === 'update')) {
        if (typeof written === 'object') return { error: { message: written.error } }
        return { data: written ? [{ id: 'inv' }] : [] }
      }
      return { data: [] }
    })
  }
  const sent = { total: 1000, amount_paid: 0, status: 'Sent' }

  it('records a part payment: Partial, balance kept, one conditional write', async () => {
    dbWith(sent)
    const r = await applyClientInvoicePayment('inv', 300, '2026-10-09')
    expect(r).toEqual({ ok: true, status: 'Partial', amountPaid: 300, amountDue: 700 })
    const upd = fake.calls.find(c => c.ops.some(o => o.m === 'update'))!
    expect(opArgs(upd, 'update')![0]).toMatchObject({ status: 'Partial', amount_paid: 300, amount_due: 700, paid_date: '2026-10-09' })
    expect(hasOp(upd, 'eq', 'amount_paid', 0)).toBe(true) // compare-and-swap on what we just read
  })
  it('"rest" pays off exactly what is still owed', async () => {
    dbWith({ total: 1000, amount_paid: 300, status: 'Partial' })
    expect(await applyClientInvoicePayment('inv', 'rest', undefined)).toEqual({ ok: true, status: 'Paid', amountPaid: 1000, amountDue: 0 })
  })
  it('a second part payment adds to the first', async () => {
    dbWith({ total: 1000, amount_paid: 300, status: 'Partial' })
    expect(await applyClientInvoicePayment('inv', 200, undefined)).toMatchObject({ ok: true, status: 'Partial', amountPaid: 500, amountDue: 500 })
  })
  it.each([[0], [-50], [NaN], [Infinity]])('refuses an amount of %s', async (amt) => {
    dbWith(sent)
    const r = await applyClientInvoicePayment('inv', amt, undefined)
    expect(r).toMatchObject({ ok: false })
    expect(fake.writes().length).toBe(0)
  })
  it('refuses more than is still owed', async () => {
    dbWith({ total: 100, amount_paid: 40, status: 'Partial' })
    const r = await applyClientInvoicePayment('inv', 61, undefined)
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('60.00') })
    expect(fake.writes().length).toBe(0)
  })
  it.each(['Cancelled', 'Split', 'Paid'])('a %s invoice takes no payment (it used to be "resurrected" to Paid)', async (status) => {
    dbWith({ total: 100, amount_paid: 0, status })
    expect(await applyClientInvoicePayment('inv', 10, undefined)).toMatchObject({ ok: false })
    expect(fake.writes().length).toBe(0)
  })
  it('a missing invoice is reported, not silently "successful"', async () => {
    dbWith(null)
    expect(await applyClientInvoicePayment('nope', 10, undefined)).toEqual({ ok: false, error: 'Invoice not found' })
  })
  it('a double click: the second write matches nothing and is told so, the payment is not added twice', async () => {
    dbWith(sent, false)
    const r = await applyClientInvoicePayment('inv', 100, undefined)
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('just changed') })
  })
  it('a database error is thrown, never reported as success', async () => {
    dbWith(sent, { error: 'constraint' })
    await expect(applyClientInvoicePayment('inv', 100, undefined)).rejects.toThrow(/could not be saved/)
  })
  it('floating point dust does not leave a phantom balance', async () => {
    dbWith({ total: 0.3, amount_paid: 0.1, status: 'Partial' })
    expect(await applyClientInvoicePayment('inv', 0.2, undefined)).toMatchObject({ ok: true, status: 'Paid', amountDue: 0 })
  })
})
