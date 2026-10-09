/**
 * Send + Remind routes: what the customer's email may contain, who it may go to, and how often.
 * dev job 1a23f5f1, council review 2026-10-09.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { makeFakeDb, hasOp, type Call } from './helpers/fake-supabase'

const state = vi.hoisted(() => ({ allowed: true }))
let fake = makeFakeDb(() => undefined)
const gmailPost = vi.hoisted(() => vi.fn(async () => ({ id: 'g1', threadId: 't1' })))
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: (t: string) => fake.db.from(t) } }))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u', app_metadata: { role: 'client' } } } }) } }) }))
vi.mock('@/lib/portal/team/gate', () => ({ canAccessAccount: vi.fn(async () => state.allowed) }))
vi.mock('@/lib/gmail', () => ({ gmailPost }))
vi.mock('@/lib/config', () => ({ APP_BASE_URL: 'https://app.example.test' }))
vi.mock('@/lib/portal/queries', () => ({ getCompanyEmail: vi.fn(async () => 'owner@company.test') }))
vi.mock('@/lib/portal/invoice-pdf', () => ({ renderInvoicePdf: vi.fn(async () => new Uint8Array([1, 2, 3])) }))

import { POST as send } from '@/app/api/portal/invoices/[id]/send/route'
import { POST as remind } from '@/app/api/portal/invoices/[id]/remind/route'

const req = () => new NextRequest('http://x/api/portal/invoices/inv-1/send', { method: 'POST' })
const ctx = { params: Promise.resolve({ id: 'inv-1' }) }

const invoice = {
  id: 'inv-1', account_id: 'acc', contact_id: null, customer_id: 'cust', invoice_number: 'INV-000007', status: 'Draft', currency: 'USD',
  issue_date: '2026-10-01', due_date: '2026-10-31', total: 1000, amount_paid: 0, amount_due: 1000,
  message: 'Pay <script>alert(1)</script> & thanks', bank_account_id: 'bank-1',
}
const customer = { name: 'Mario <b>Rossi</b>', email: 'mario@rossi.it' }
const bank = { label: 'Main "USD"', account_holder: 'A&B <i>LLC</i>', iban: 'IT60X', notes: '<img src=x onerror=1>' }

function script(over: { invoice?: object; customer?: object | null; recent?: number; link?: string | null } = {}) {
  return (c: Call) => {
    const sel = c.ops.find(o => o.m === 'select')
    if (c.table === 'client_invoices' && sel) return { data: { ...invoice, ...(over.invoice ?? {}) } }
    if (c.table === 'client_customers') return { data: over.customer === undefined ? customer : over.customer }
    if (c.table === 'accounts') return { data: { company_name: 'Acme "Società", S.r.l.' } }
    if (c.table === 'client_bank_accounts') return { data: bank }
    if (c.table === 'payment_links') return { data: over.link === undefined ? { url: 'https://buy.stripe.com/abc123' } : over.link ? { url: over.link } : null }
    if (c.table === 'email_tracking' && c.ops.some(o => o.m === 'select')) return { count: over.recent ?? 0 }
    return { data: [] }
  }
}

const raw = () => {
  const call = gmailPost.mock.calls[0] as unknown as [string, { raw: string }]
  const mime = Buffer.from(call[1].raw, 'base64url').toString('utf8')
  const html = Buffer.from(mime.split('Content-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n')[0], 'base64').toString('utf8')
  return { mime, html }
}

beforeEach(() => { state.allowed = true; gmailPost.mockClear() })

describe('POST send', () => {
  it.each(['Cancelled', 'Split'])('never emails a %s invoice', async (status) => {
    fake = makeFakeDb(script({ invoice: { status } }))
    const res = await send(req(), ctx)
    expect(res.status).toBe(400)
    expect(gmailPost).not.toHaveBeenCalled()
  })

  it('refuses a customer email that could carry extra headers', async () => {
    fake = makeFakeDb(script({ customer: { name: 'X', email: 'a@b.co\r\nBcc: evil@x.com' } }))
    expect((await send(req(), ctx)).status).toBe(400)
    expect(gmailPost).not.toHaveBeenCalled()
  })

  it('a second click within a minute is refused and sends nothing', async () => {
    fake = makeFakeDb(script({ recent: 1 }))
    const res = await send(req(), ctx)
    expect(res.status).toBe(409)
    expect(gmailPost).not.toHaveBeenCalled()
  })

  it('escapes everything the client typed, so no markup reaches the customer', async () => {
    fake = makeFakeDb(script())
    const res = await send(req(), ctx)
    expect(res.status).toBe(200)
    const { html } = raw()
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<b>Rossi</b>')
    expect(html).toContain('Pay &lt;script&gt;alert(1)&lt;/script&gt; &amp; thanks')
    expect(html).toContain('A&amp;B &lt;i&gt;LLC&lt;/i&gt;')
    expect(html).toContain('Bank Details — Main &quot;USD&quot;')
  })

  it('encodes the company name in the From header (accents, quotes and commas cannot break it)', async () => {
    fake = makeFakeDb(script())
    await send(req(), ctx)
    const { mime } = raw()
    expect(mime).toMatch(/^From: =\?utf-8\?B\?[A-Za-z0-9+/=]+\?= <support@tonydurante\.us>$/m)
    expect(mime).toMatch(/filename="INV-000007\.pdf"/)
  })

  it('claims the send in the email log BEFORE emailing, and flips Draft -> Sent only after', async () => {
    fake = makeFakeDb(script())
    await send(req(), ctx)
    const tracking = fake.calls.findIndex(c => c.table === 'email_tracking' && c.ops.some(o => o.m === 'insert'))
    const flip = fake.calls.findIndex(c => c.table === 'client_invoices' && c.ops.some(o => o.m === 'update'))
    expect(tracking).toBeGreaterThan(-1)
    expect(flip).toBeGreaterThan(tracking)
    expect(hasOp(fake.calls[flip], 'eq', 'status', 'Draft')).toBe(true)
  })

  it('reads the bank account only from THIS company', async () => {
    fake = makeFakeDb(script())
    await send(req(), ctx)
    const bankQuery = fake.calls.find(c => c.table === 'client_bank_accounts')!
    expect(hasOp(bankQuery, 'eq', 'account_id', 'acc')).toBe(true)
  })

  it('only a plain https payment link becomes the Pay Now button', async () => {
    fake = makeFakeDb(script({ link: 'javascript:alert(1)' }))
    await send(req(), ctx)
    expect(raw().html).not.toContain('Pay Now')
  })

  it('if the email fails, the claim is removed so the client can try again', async () => {
    gmailPost.mockRejectedValueOnce(new Error('gmail down'))
    fake = makeFakeDb(script())
    const res = await send(req(), ctx)
    expect(res.status).toBe(500)
    expect(fake.calls.some(c => c.table === 'email_tracking' && c.ops.some(o => o.m === 'delete'))).toBe(true)
    expect(fake.calls.some(c => c.table === 'client_invoices' && c.ops.some(o => o.m === 'update'))).toBe(false)
  })

  it('re-sending a Sent invoice stays allowed and leaves its status alone', async () => {
    fake = makeFakeDb(script({ invoice: { status: 'Sent' } }))
    const res = await send(req(), ctx)
    expect(res.status).toBe(200)
    expect(fake.calls.some(c => c.table === 'client_invoices' && c.ops.some(o => o.m === 'update'))).toBe(false)
  })

  it('denies a caller from another company', async () => {
    state.allowed = false
    fake = makeFakeDb(script())
    expect((await send(req(), ctx)).status).toBe(403)
    expect(gmailPost).not.toHaveBeenCalled()
  })
})

describe('POST remind', () => {
  const sent = { status: 'Sent' }
  it.each(['Draft', 'Paid', 'Cancelled', 'Split'])('does not remind a %s invoice', async (status) => {
    fake = makeFakeDb(script({ invoice: { status } }))
    expect((await remind(req(), ctx)).status).toBe(400)
    expect(gmailPost).not.toHaveBeenCalled()
  })

  it('reminds a part-paid invoice for what is STILL owed, not the full total', async () => {
    fake = makeFakeDb(script({ invoice: { status: 'Partial', total: 1000, amount_paid: 400, amount_due: 600 } }))
    const res = await remind(req(), ctx)
    expect(res.status).toBe(200)
    const { html } = raw()
    expect(html).toContain('$600.00')
    expect(html).not.toContain('$1000.00')
  })

  it('at most one reminder per invoice per customer in 12 hours', async () => {
    fake = makeFakeDb(script({ invoice: sent, recent: 1 }))
    const res = await remind(req(), ctx)
    expect(res.status).toBe(429)
    expect(gmailPost).not.toHaveBeenCalled()
  })

  it('writes the reminder into the email log (that log IS the throttle) and escapes client text', async () => {
    fake = makeFakeDb(script({ invoice: sent }))
    await remind(req(), ctx)
    expect(fake.calls.some(c => c.table === 'email_tracking' && c.ops.some(o => o.m === 'insert'))).toBe(true)
    const { html } = raw()
    expect(html).not.toContain('<script>')
    expect(html).toContain('Mario &lt;b&gt;Rossi&lt;/b&gt;')
  })

  it('refuses an unsafe customer address', async () => {
    fake = makeFakeDb(script({ invoice: sent, customer: { name: 'X', email: 'a@b.co, c@d.co' } }))
    expect((await remind(req(), ctx)).status).toBe(400)
  })
})
