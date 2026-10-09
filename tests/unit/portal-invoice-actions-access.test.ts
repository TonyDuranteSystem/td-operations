/**
 * Every exported client-invoicing server action is a PUBLIC endpoint ('use server'). This test makes forgetting the
 * ownership guard a failing test, and proves the dangerous paths: forged company, forged status, foreign references,
 * payments. (dev job 1a23f5f1, council review 2026-10-09)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { makeFakeDb, hasOp, opArgs, type Call } from './helpers/fake-supabase'

const state = vi.hoisted(() => ({
  access: { ok: true, accountId: 'acc-1', user: { email: 'mario@rossi.it', app_metadata: { role: 'client' } } } as { ok: boolean; accountId?: string; user?: unknown; error?: string },
  owned: true,
  script: (_c: unknown): unknown => undefined,
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/server-action', async () => {
  return { safeAction: async (fn: () => Promise<unknown>) => { try { return { success: true, data: await fn() } } catch (e) { return { success: false, error: e instanceof Error ? e.message : 'x' } } } }
})
vi.mock('@/lib/portal/invoice-audit', () => ({ logInvoiceAudit: vi.fn() }))
vi.mock('@/lib/portal/unified-invoice', () => ({
  createUnifiedInvoice: vi.fn(async () => ({ invoiceId: 'new-inv', invoiceNumber: 'INV-000001' })),
  applyClientInvoicePayment: vi.fn(async () => ({ ok: true, status: 'Paid', amountPaid: 100, amountDue: 0 })),
}))
vi.mock('@/lib/portal/invoice-access', () => ({
  authorizeAccount: vi.fn(async () => state.access),
  authorizeInvoice: vi.fn(async () => state.access),
  belongsToAccount: vi.fn(async () => state.owned),
  actorLabel: () => 'client:mario',
}))

let fake = makeFakeDb(() => undefined)
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: (t: string) => fake.db.from(t) } }))

import * as actions from '@/app/portal/invoices/actions'
import { createUnifiedInvoice, applyClientInvoicePayment } from '@/lib/portal/unified-invoice'

const ID = '11111111-1111-4111-8111-111111111111'
const CUST = '22222222-2222-4222-8222-222222222222'
const BANK = '33333333-3333-4333-8333-333333333333'
const ACC = '44444444-4444-4444-8444-444444444444'

beforeEach(() => {
  state.access = { ok: true, accountId: 'acc-1', user: { email: 'mario@rossi.it', app_metadata: { role: 'client' } } }
  state.owned = true
  fake = makeFakeDb(() => undefined)
  vi.mocked(createUnifiedInvoice).mockClear()
  vi.mocked(applyClientInvoicePayment).mockClear()
})

describe('structure: no exported action may skip the guard', () => {
  const source = readFileSync('app/portal/invoices/actions.ts', 'utf8')
  const exported = Array.from(source.matchAll(/export async function (\w+)\(([\s\S]*?)\n\}\n/g))
  it('finds the exported actions', () => {
    expect(exported.length).toBeGreaterThanOrEqual(9)
  })
  for (const m of exported) {
    it(`${m[1]} starts with authorizeAccount / authorizeInvoice`, () => {
      expect(m[0]).toMatch(/authorize(Account|Invoice)\(/)
    })
  }
  it('listVendors is guarded too', () => {
    expect(readFileSync('app/portal/invoices/vendor-actions.ts', 'utf8')).toMatch(/export async function listVendors[\s\S]*?assertOwnsVendorAccount/)
  })
  it('splitInvoice (unused, unsafe) no longer exists as an endpoint', () => {
    expect(source).not.toMatch(/export async function splitInvoice/)
  })
})

describe('a caller who may not act is stopped before anything is read or written', () => {
  beforeEach(() => { state.access = { ok: false, error: 'Invoice not found' } })
  it.each([
    ['voidInvoice', () => actions.voidInvoice(ID)],
    ['markInvoiceAsPaid', () => actions.markInvoiceAsPaid(ID, '2026-10-09')],
    ['recordPartialPayment', () => actions.recordPartialPayment(ID, 10, '2026-10-09')],
    ['duplicateInvoice', () => actions.duplicateInvoice(ID)],
    ['updateInvoice', () => actions.updateInvoice({ id: ID, notes: 'x' })],
    ['deleteTemplate', () => actions.deleteTemplate(ID, ACC)],
  ])('%s', async (_n, call) => {
    const r = await call()
    expect(r).toEqual({ success: false, error: 'Invoice not found' })
    expect(fake.calls.length).toBe(0)
    expect(applyClientInvoicePayment).not.toHaveBeenCalled()
  })
  it('listTemplates returns an empty list, never throws', async () => {
    expect(await actions.listTemplates(ACC)).toEqual([])
    expect(fake.calls.length).toBe(0)
  })
})

describe('updateInvoice — whitelist and server-side totals', () => {
  function invoiceRow(over: Record<string, unknown> = {}) {
    return { status: 'Draft', subtotal: 100, discount: 0, tax_total: 0, amount_paid: 0, currency: 'USD', ...over }
  }
  function script(row: Record<string, unknown>) {
    return (c: Call) => {
      if (c.table === 'client_invoices' && c.ops.some(o => o.m === 'maybeSingle')) return { data: row }
      if (c.table === 'client_invoices' && c.ops.some(o => o.m === 'update')) return { data: [{ id: ID }] }
      return { data: [] }
    }
  }

  it('ignores a forged account, status and paid date', async () => {
    fake = makeFakeDb(script(invoiceRow()))
    const r = await actions.updateInvoice({
      id: ID, notes: 'hello',
      // forged extras a malicious caller could add (zod strips them)
      ...({ account_id: ACC, status: 'Paid', paid_date: '2026-01-01', amount_paid: 9999 } as object),
    } as never)
    expect(r.success).toBe(true)
    const upd = fake.calls.find(c => c.table === 'client_invoices' && c.ops.some(o => o.m === 'update'))!
    const payload = opArgs(upd, 'update')![0] as Record<string, unknown>
    expect(payload).not.toHaveProperty('account_id')
    expect(payload).not.toHaveProperty('status')
    expect(payload).not.toHaveProperty('paid_date')
    expect(payload).not.toHaveProperty('amount_paid')
    expect(payload.notes).toBe('hello')
    // and the write is pinned to the STORED company
    expect(hasOp(upd, 'eq', 'account_id', 'acc-1')).toBe(true)
  })

  it('computes totals from quantity x price on the server, ignoring the browser amount', async () => {
    fake = makeFakeDb(script(invoiceRow()))
    await actions.updateInvoice({
      id: ID, discount: 10,
      items: [{ description: 'A', quantity: 2, unit_price: 50, amount: 1, sort_order: 0 }, { description: 'B', quantity: 1, unit_price: 25.5, amount: 1, sort_order: 1 }],
    })
    const upd = fake.calls.find(c => c.table === 'client_invoices' && c.ops.some(o => o.m === 'update'))!
    const p = opArgs(upd, 'update')![0] as Record<string, number>
    expect(p.subtotal).toBe(125.5)
    expect(p.discount).toBe(10)
    expect(p.total).toBe(115.5)
    expect(p.amount_due).toBe(115.5)
  })

  it('clamps a discount larger than the subtotal', async () => {
    fake = makeFakeDb(script(invoiceRow()))
    await actions.updateInvoice({ id: ID, discount: 5000, items: [{ description: 'A', quantity: 1, unit_price: 100, amount: 100, sort_order: 0 }] })
    const upd = fake.calls.find(c => c.table === 'client_invoices' && c.ops.some(o => o.m === 'update'))!
    const p = opArgs(upd, 'update')![0] as Record<string, number>
    expect(p.discount).toBe(100)
    expect(p.total).toBe(0)
  })

  it('recomputes the balance and moves a part-paid invoice back to Partial when the total goes up', async () => {
    fake = makeFakeDb(script(invoiceRow({ status: 'Paid', subtotal: 100, amount_paid: 100 })))
    await actions.updateInvoice({ id: ID, items: [{ description: 'A', quantity: 1, unit_price: 300, amount: 300, sort_order: 0 }] })
    const upd = fake.calls.find(c => c.table === 'client_invoices' && c.ops.some(o => o.m === 'update'))!
    const p = opArgs(upd, 'update')![0] as Record<string, unknown>
    expect(p.amount_due).toBe(200)
    expect(p.status).toBe('Partial')
  })

  it('refuses to edit a voided invoice', async () => {
    fake = makeFakeDb(script(invoiceRow({ status: 'Cancelled' })))
    const r = await actions.updateInvoice({ id: ID, notes: 'x' })
    expect(r).toMatchObject({ success: false })
    expect(fake.writes().length).toBe(0)
  })

  it('refuses a customer or bank account that belongs to another company', async () => {
    fake = makeFakeDb(script(invoiceRow()))
    state.owned = false
    const a = await actions.updateInvoice({ id: ID, customer_id: CUST })
    const b = await actions.updateInvoice({ id: ID, bank_account_id: BANK })
    expect(a).toMatchObject({ success: false })
    expect(b).toMatchObject({ success: false })
    expect(fake.writes().length).toBe(0)
  })

  it('puts the old lines back if saving the new ones fails', async () => {
    let inserts = 0
    fake = makeFakeDb(c => {
      if (c.table === 'client_invoices' && c.ops.some(o => o.m === 'maybeSingle')) return { data: invoiceRow() }
      if (c.table === 'client_invoice_items' && c.ops.some(o => o.m === 'insert')) { inserts++; return inserts === 1 ? { error: { message: 'boom' } } : { data: [] } }
      if (c.table === 'client_invoice_items' && c.ops.some(o => o.m === 'select')) return { data: [{ description: 'old', quantity: 1, unit_price: 1 }] }
      return { data: [] }
    })
    const r = await actions.updateInvoice({ id: ID, items: [{ description: 'A', quantity: 1, unit_price: 10, amount: 10, sort_order: 0 }] })
    expect(r).toMatchObject({ success: false })
    expect(inserts).toBe(2) // the new lines failed, the old ones were restored
  })
})

describe('createInvoice', () => {
  const base = {
    account_id: ACC, customer_id: CUST, currency: 'USD' as const, discount: 25, issue_date: '2026-10-01',
    bank_account_id: BANK, items: [{ description: 'A', quantity: 1, unit_price: 100, amount: 100, sort_order: 0 }],
  }
  it('passes discount, issue date and bank account through (they used to be dropped)', async () => {
    const r = await actions.createInvoice(base)
    expect(r.success).toBe(true)
    expect(createUnifiedInvoice).toHaveBeenCalledWith(expect.objectContaining({
      account_id: 'acc-1', discount: 25, issue_date: '2026-10-01', bank_account_id: BANK, customer_id: CUST,
    }))
  })
  it('uses the authorized company, not a different one smuggled in elsewhere', async () => {
    await actions.createInvoice(base)
    expect(vi.mocked(createUnifiedInvoice).mock.calls[0][0].account_id).toBe('acc-1')
  })
  it('refuses a customer or bank account of another company', async () => {
    state.owned = false
    expect(await actions.createInvoice(base)).toMatchObject({ success: false })
    expect(createUnifiedInvoice).not.toHaveBeenCalled()
  })
})

describe('payments go through the one checked writer', () => {
  it('mark paid asks for the whole remaining balance', async () => {
    await actions.markInvoiceAsPaid(ID, '2026-10-09')
    expect(applyClientInvoicePayment).toHaveBeenCalledWith(ID, 'rest', '2026-10-09', 'client:mario')
  })
  it('a partial payment passes the amount; a refusal becomes the error the client sees', async () => {
    vi.mocked(applyClientInvoicePayment).mockResolvedValueOnce({ ok: false, error: 'The payment is more than what is still owed (10.00).' } as never)
    const r = await actions.recordPartialPayment(ID, 50, '2026-10-09')
    expect(applyClientInvoicePayment).toHaveBeenCalledWith(ID, 50, '2026-10-09', 'client:mario')
    expect(r).toEqual({ success: false, error: 'The payment is more than what is still owed (10.00).' })
  })
})

describe('voidInvoice', () => {
  it('only voids a live invoice and pins the write to the stored company', async () => {
    fake = makeFakeDb(c => {
      if (c.ops.some(o => o.m === 'maybeSingle')) return { data: { status: 'Sent' } }
      if (c.ops.some(o => o.m === 'update')) return { data: [{ id: ID }] }
      return { data: [] }
    })
    expect((await actions.voidInvoice(ID)).success).toBe(true)
    const upd = fake.calls.find(c => c.ops.some(o => o.m === 'update'))!
    expect(hasOp(upd, 'eq', 'account_id', 'acc-1')).toBe(true)
  })
  it('refuses an already voided or split invoice', async () => {
    for (const status of ['Cancelled', 'Split']) {
      fake = makeFakeDb(c => (c.ops.some(o => o.m === 'maybeSingle') ? { data: { status } } : { data: [] }))
      expect(await actions.voidInvoice(ID)).toMatchObject({ success: false })
      expect(fake.writes().length).toBe(0)
    }
  })
  it('reports a change that happened in between instead of pretending', async () => {
    fake = makeFakeDb(c => {
      if (c.ops.some(o => o.m === 'maybeSingle')) return { data: { status: 'Sent' } }
      return { data: [] } // the guarded update matched nothing
    })
    expect(await actions.voidInvoice(ID)).toMatchObject({ success: false })
  })
})

describe('duplicateInvoice keeps the discount and the bank account', () => {
  it('copies them from the source invoice', async () => {
    fake = makeFakeDb(c => (c.ops.some(o => o.m === 'maybeSingle')
      ? { data: { customer_id: CUST, currency: 'EUR', discount: 15, bank_account_id: BANK, notes: null, message: 'm', client_invoice_items: [{ description: 'A', unit_price: 100, quantity: 1, tax_rate: 0.22 }] } }
      : { data: [] }))
    await actions.duplicateInvoice(ID)
    expect(createUnifiedInvoice).toHaveBeenCalledWith(expect.objectContaining({
      discount: 15, bank_account_id: BANK, currency: 'EUR', account_id: 'acc-1',
      line_items: [expect.objectContaining({ tax_rate: 0.22 })],
    }))
  })
})
