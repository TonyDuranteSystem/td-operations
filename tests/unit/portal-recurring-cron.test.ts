/**
 * The client's recurring sales invoices job. dev job 1a23f5f1, council review 2026-10-09.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDb, hasOp, opArgs } from './helpers/fake-supabase'

let fake = makeFakeDb(() => undefined)
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: (t: string) => fake.db.from(t) } }))
vi.mock('@/lib/cron-log', () => ({ logCron: vi.fn() }))
vi.mock('@/lib/portal/notifications', () => ({ createPortalNotification: vi.fn(async () => undefined) }))
vi.mock('@/lib/portal/office-hours', () => ({ getOfficeDateString: () => '2026-10-31' }))
const createUnifiedInvoice = vi.hoisted(() => vi.fn(async () => ({ invoiceId: 'copy-1', invoiceNumber: 'INV-2' })))
vi.mock('@/lib/portal/unified-invoice', () => ({ createUnifiedInvoice }))

import { GET } from '@/app/api/cron/portal-recurring-invoices/route'

const req = (auth?: string) => new Request('http://x/api/cron/portal-recurring-invoices', { headers: auth ? { authorization: auth } : {} })

const template = {
  id: 'tpl-1', account_id: 'acc', contact_id: null, customer_id: 'cust', invoice_number: 'INV-1', currency: 'EUR',
  issue_date: '2026-01-31', due_date: '2026-02-15', recurring_frequency: 'monthly', recurring_next_date: '2026-10-31',
  recurring_end_date: null, discount: 10, bank_account_id: 'bank', notes: 'n', message: 'm',
  client_invoice_items: [{ description: 'Retainer', quantity: 1, unit_price: 500, tax_rate: 0.22 }],
}

beforeEach(() => {
  process.env.CRON_SECRET = 'sekret'
  createUnifiedInvoice.mockClear()
})

describe('authentication', () => {
  it('refuses everyone without the secret', async () => {
    fake = makeFakeDb(() => ({ data: [] }))
    expect((await GET(req())).status).toBe(401)
    expect((await GET(req('Bearer wrong'))).status).toBe(401)
    expect(fake.calls.length).toBe(0)
  })
  it('refuses everyone when the secret is not configured (fail closed, not "Bearer undefined")', async () => {
    delete process.env.CRON_SECRET
    fake = makeFakeDb(() => ({ data: [] }))
    expect((await GET(req('Bearer undefined'))).status).toBe(401)
    expect((await GET(req())).status).toBe(401)
  })
})

describe('generating a cycle', () => {
  it('makes one draft copy keyed to the cycle, copies discount/bank/tax, and advances the date without drifting', async () => {
    fake = makeFakeDb(c => {
      if (c.ops.some(o => o.m === 'select' && String(o.args[0]).includes('client_invoice_items'))) return { data: [template] }
      if (c.ops.some(o => o.m === 'update')) return { data: [{ id: 'tpl-1' }] }
      return { data: [] }
    })
    const res = await GET(req('Bearer sekret'))
    expect(await res.json()).toEqual({ generated: 1, checked: 1, failed: 0 })
    expect(createUnifiedInvoice).toHaveBeenCalledWith(expect.objectContaining({
      idempotency_key: 'recurring:tpl-1:2026-10-31', issue_date: '2026-10-31', discount: 10, bank_account_id: 'bank',
      recurring_parent_id: 'tpl-1', due_date: '2026-11-15', currency: 'EUR',
      line_items: [expect.objectContaining({ tax_rate: 0.22 })],
    }))
    const upd = fake.calls.find(c => c.ops.some(o => o.m === 'update'))!
    expect(opArgs(upd, 'update')![0]).toEqual({ recurring_next_date: '2026-11-30' }) // anchored on the 31st: Oct 31 -> Nov 30
    expect(hasOp(upd, 'eq', 'recurring_next_date', '2026-10-31')).toBe(true) // compare-and-swap on the cycle date
  })

  it('stops the schedule after its end date', async () => {
    fake = makeFakeDb(c => {
      if (c.ops.some(o => o.m === 'select' && String(o.args[0]).includes('client_invoice_items'))) return { data: [{ ...template, recurring_end_date: '2026-11-15' }] }
      if (c.ops.some(o => o.m === 'update')) return { data: [{ id: 'tpl-1' }] }
      return { data: [] }
    })
    await GET(req('Bearer sekret'))
    const upd = fake.calls.find(c => c.ops.some(o => o.m === 'update'))!
    expect(opArgs(upd, 'update')![0]).toEqual({ recurring_next_date: null })
  })

  it('reports a failure as an error, never as success, and does not advance a cycle that failed', async () => {
    createUnifiedInvoice.mockRejectedValueOnce(new Error('db down'))
    fake = makeFakeDb(c => (c.ops.some(o => o.m === 'select' && String(o.args[0]).includes('client_invoice_items')) ? { data: [template] } : { data: [] }))
    const body = await (await GET(req('Bearer sekret'))).json()
    expect(body).toMatchObject({ generated: 0, failed: 1 })
    expect(fake.calls.some(c => c.ops.some(o => o.m === 'update'))).toBe(false)
  })

  it('a template with no lines is reported, not skipped silently', async () => {
    fake = makeFakeDb(c => (c.ops.some(o => o.m === 'select' && String(o.args[0]).includes('client_invoice_items')) ? { data: [{ ...template, client_invoice_items: [] }] } : { data: [] }))
    expect(await (await GET(req('Bearer sekret'))).json()).toMatchObject({ generated: 0, failed: 1 })
  })

  it('only looks at invoices the client has actually sent, whose date has come', async () => {
    fake = makeFakeDb(() => ({ data: [] }))
    await GET(req('Bearer sekret'))
    const q = fake.calls[0]
    expect(hasOp(q, 'in', 'status', ['Sent', 'Paid'])).toBe(true)
    expect(hasOp(q, 'lte', 'recurring_next_date', '2026-10-31')).toBe(true)
  })
})
