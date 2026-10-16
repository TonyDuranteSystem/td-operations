/**
 * Where a CLIENT's invoice emails leave from (dev job 1a23f5f1, Antonio 2026-10-16): the dedicated invoicing address on
 * its own domain through Resend, with today's Gmail path as the safe default and the instant way back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { makeFakeDb, type Call } from './helpers/fake-supabase'
import { resolveInvoiceSender, fromAddressFor, invoiceFromAddress, deliverInvoiceEmail, GMAIL_FROM_ADDRESS } from '@/lib/portal/invoice-mailer'

const state = vi.hoisted(() => ({ sender: 'gmail' as unknown }))
let fake = makeFakeDb(() => undefined)
const gmailPost = vi.hoisted(() => vi.fn(async () => ({ id: 'g1', threadId: 't1' })))
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: (t: string) => fake.db.from(t) } }))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u', app_metadata: { role: 'client' } } } }) } }) }))
vi.mock('@/lib/portal/team/gate', () => ({ canAccessAccount: vi.fn(async () => true) }))
vi.mock('@/lib/gmail', () => ({ gmailPost }))
vi.mock('@/lib/settings', () => ({ getInvoiceEmailSenderSetting: vi.fn(async () => state.sender) }))
vi.mock('@/lib/config', () => ({ APP_BASE_URL: 'https://app.example.test' }))
vi.mock('@/lib/portal/queries', () => ({ getCompanyEmail: vi.fn(async () => 'owner@company.test') }))
vi.mock('@/lib/portal/invoice-pdf', () => ({ renderInvoicePdf: vi.fn(async () => new Uint8Array([1, 2, 3])) }))

import { POST as send } from '@/app/api/portal/invoices/[id]/send/route'
import { POST as remind } from '@/app/api/portal/invoices/[id]/remind/route'

const envBefore = { ...process.env }
afterEach(() => { process.env = { ...envBefore }; vi.unstubAllGlobals() })

describe('choosing the sender', () => {
  it('Gmail (today) unless the setting says resend AND a key exists', () => {
    expect(resolveInvoiceSender(undefined, true)).toBe('gmail')
    expect(resolveInvoiceSender('gmail', true)).toBe('gmail')
    expect(resolveInvoiceSender('resend', false)).toBe('gmail')
    expect(resolveInvoiceSender('RESEND', true)).toBe('gmail')
    expect(resolveInvoiceSender(null, true)).toBe('gmail')
    expect(resolveInvoiceSender('resend', true)).toBe('resend')
    expect(resolveInvoiceSender({ sender: 'resend' }, true)).toBe('resend')
  })
  it('a company list starts with chosen companies only; anything unclear fails closed to Gmail', () => {
    const s = { sender: 'resend', account_ids: ['acc-1', 'acc-2'] }
    expect(resolveInvoiceSender(s, true, 'acc-1')).toBe('resend')
    expect(resolveInvoiceSender(s, true, 'acc-9')).toBe('gmail')
    expect(resolveInvoiceSender(s, true, null)).toBe('gmail')
    expect(resolveInvoiceSender(s, false, 'acc-1')).toBe('gmail')
    expect(resolveInvoiceSender({ sender: 'resend', account_ids: [] }, true, 'acc-1')).toBe('gmail')
    expect(resolveInvoiceSender({ sender: 'resend', account_ids: 'acc-1' }, true, 'acc-1')).toBe('gmail')
    expect(resolveInvoiceSender({ sender: 'gmail', account_ids: ['acc-1'] }, true, 'acc-1')).toBe('gmail')
  })
  it('the from address follows the sender, and a bad override falls back to the real domain', () => {
    expect(fromAddressFor('gmail')).toBe(GMAIL_FROM_ADDRESS)
    delete process.env.INVOICE_FROM_ADDRESS
    expect(fromAddressFor('resend')).toBe('invoices@tdinvoice.com')
    process.env.INVOICE_FROM_ADDRESS = 'billing@tdinvoice.com'
    expect(invoiceFromAddress()).toBe('billing@tdinvoice.com')
    process.env.INVOICE_FROM_ADDRESS = 'evil@x.com>\r\nBcc: a@b.co'
    expect(invoiceFromAddress()).toBe('invoices@tdinvoice.com')
  })
})

describe('delivering through Resend', () => {
  const email = { sender: 'resend' as const, fromName: 'MDL Advisory LLC', to: 'cliente@example.it', subject: 'Invoice INV-1 from MDL Advisory LLC', html: '<p>hi</p>', replyTo: 'owner@mdl.test', attachment: { base64: 'AQID', filename: 'INV-1.pdf' } }

  it('sends the client name from the dedicated address, replies to the client, attaches the PDF', async () => {
    process.env.RESEND_API_KEY = 're_test'
    delete process.env.SANDBOX_MODE
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'rs_1' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await deliverInvoiceEmail(email)
    expect(r).toEqual({ provider: 'resend', messageId: 'rs_1', threadId: null })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }]
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.headers.Authorization).toBe('Bearer re_test')
    const body = JSON.parse(init.body)
    expect(body.from).toBe('MDL Advisory LLC <invoices@tdinvoice.com>')
    expect(body.to).toEqual(['cliente@example.it'])
    expect(body.reply_to).toBe('owner@mdl.test')
    expect(body.attachments).toEqual([{ filename: 'INV-1.pdf', content: 'AQID' }])
    expect(JSON.stringify(body)).not.toContain('support@tonydurante.us')
    expect(gmailPost).not.toHaveBeenCalled()
  })
  it('a company name with quotes, angle brackets or line breaks cannot break the sender line', async () => {
    process.env.RESEND_API_KEY = 're_test'
    delete process.env.SANDBOX_MODE
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await deliverInvoiceEmail({ ...email, fromName: 'Evil" <x@y.z>\r\nBcc: a@b.co' })
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body)
    expect(body.from).not.toMatch(/[\r\n]/)
    expect(body.from.endsWith('<invoices@tdinvoice.com>')).toBe(true)
    expect((body.from.match(/</g) ?? []).length).toBe(1)
  })
  it('a refusal from Resend throws (so the claim row is removed and the client sees a failure)', async () => {
    process.env.RESEND_API_KEY = 're_test'
    delete process.env.SANDBOX_MODE
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'domain not verified' }), { status: 403 })))
    await expect(deliverInvoiceEmail(email)).rejects.toThrow(/403.*domain not verified/)
  })
  it('without a key it throws instead of sending anything, and the sandbox never reaches Resend', async () => {
    delete process.env.RESEND_API_KEY
    delete process.env.SANDBOX_MODE
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(deliverInvoiceEmail(email)).rejects.toThrow(/RESEND_API_KEY/)
    process.env.RESEND_API_KEY = 're_test'
    process.env.SANDBOX_MODE = '1'
    const r = await deliverInvoiceEmail(email)
    expect(r.messageId).toBe('sandbox-blocked')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('the Gmail path is unchanged: support@ with the client name, nothing goes to Resend', async () => {
    gmailPost.mockClear()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const r = await deliverInvoiceEmail({ ...email, sender: 'gmail' })
    expect(r.provider).toBe('gmail')
    expect(r.messageId).toBe('g1')
    const mime = Buffer.from((gmailPost.mock.calls[0] as unknown as [string, { raw: string }])[1].raw, 'base64url').toString('utf8')
    expect(mime).toContain('<support@tonydurante.us>')
    expect(mime).toContain('Reply-To: owner@mdl.test')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the Send and Remind routes use the chosen sender', () => {
  const invoice = { id: 'inv-1', account_id: 'acc', contact_id: null, customer_id: 'cust', invoice_number: 'INV-000007', status: 'Sent', currency: 'EUR', issue_date: '2026-10-01', due_date: '2026-10-31', total: 150, amount_paid: 0, amount_due: 150, message: null, bank_account_id: null }
  const script = (c: Call) => {
    const sel = c.ops.find(o => o.m === 'select')
    if (c.table === 'client_invoices' && sel) return { data: invoice }
    if (c.table === 'client_customers') return { data: { name: 'Locarno Alessandro', email: 'alessandro@alatudi.it' } }
    if (c.table === 'accounts') return { data: { company_name: 'MDL Advisory LLC' } }
    if (c.table === 'email_tracking' && c.ops.some(o => o.m === 'select')) return { data: [] }
    return { data: [] }
  }
  const req = () => new NextRequest('http://x/api/portal/invoices/inv-1/send', { method: 'POST' })
  const ctx = { params: Promise.resolve({ id: 'inv-1' }) }
  beforeEach(() => { gmailPost.mockClear(); delete process.env.SANDBOX_MODE })

  it('setting resend + key: Send goes through Resend, the tracking row carries the invoicing address, Gmail is not used', async () => {
    state.sender = 'resend'
    process.env.RESEND_API_KEY = 're_test'
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'rs_9' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    fake = makeFakeDb(script)
    const res = await send(req(), ctx)
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(gmailPost).not.toHaveBeenCalled()
    const claim = fake.calls.find(c => c.table === 'email_tracking' && c.ops.some(o => o.m === 'insert'))!
    expect(JSON.stringify(claim.ops.find(o => o.m === 'insert')!.args[0])).toContain('invoices@tdinvoice.com')
  })
  it('Remind follows the same switch', async () => {
    state.sender = 'resend'
    process.env.RESEND_API_KEY = 're_test'
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'rs_10' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    fake = makeFakeDb(script)
    const res = await remind(new NextRequest('http://x/api/portal/invoices/inv-1/remind', { method: 'POST' }), ctx)
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(gmailPost).not.toHaveBeenCalled()
  })
  it('a company list: a company on it goes through Resend, a company not on it stays on Gmail', async () => {
    state.sender = { sender: 'resend', account_ids: ['other-company'] }
    process.env.RESEND_API_KEY = 're_test'
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'rs_11' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    fake = makeFakeDb(script)
    expect((await send(req(), ctx)).status).toBe(200)
    expect(gmailPost).toHaveBeenCalledTimes(1) // this invoice's company ('acc') is not on the list
    expect(fetchMock).not.toHaveBeenCalled()
    gmailPost.mockClear()
    state.sender = { sender: 'resend', account_ids: ['acc'] }
    fake = makeFakeDb(script)
    expect((await send(req(), ctx)).status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(gmailPost).not.toHaveBeenCalled()
  })
  it('setting resend but NO key: invoices still go out through Gmail (a missing key never stops them)', async () => {
    state.sender = 'resend'
    delete process.env.RESEND_API_KEY
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    fake = makeFakeDb(script)
    expect((await send(req(), ctx)).status).toBe(200)
    expect(gmailPost).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('default setting: Gmail, exactly as before', async () => {
    state.sender = 'gmail'
    process.env.RESEND_API_KEY = 're_test'
    fake = makeFakeDb(script)
    expect((await send(req(), ctx)).status).toBe(200)
    expect(gmailPost).toHaveBeenCalledTimes(1)
  })
  it('Resend failing removes the claim row and returns an error, so a retry is not blocked', async () => {
    state.sender = 'resend'
    process.env.RESEND_API_KEY = 're_test'
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    fake = makeFakeDb(script)
    expect((await send(req(), ctx)).status).toBe(500)
    expect(fake.calls.some(c => c.table === 'email_tracking' && c.ops.some(o => o.m === 'delete'))).toBe(true)
  })
})
