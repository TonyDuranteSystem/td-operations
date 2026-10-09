/**
 * Bank accounts, customers and the logo upload: the small holes found in the 2026-10-09 review of the client
 * invoicing area (dev job 1a23f5f1).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { makeFakeDb, hasOp, opArgs, type Call } from './helpers/fake-supabase'

const state = vi.hoisted(() => ({ allowed: true }))
let fake = makeFakeDb(() => undefined)
const upload = vi.hoisted(() => vi.fn(async () => ({ error: null })))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (t: string) => fake.db.from(t),
    storage: { from: () => ({ upload, getPublicUrl: () => ({ data: { publicUrl: 'https://cdn.test/portal-logos/acc.png' } }) }) },
  },
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u', app_metadata: { role: 'client' } } } }) } }) }))
vi.mock('@/lib/portal/team/gate', () => ({ canAccessAccount: vi.fn(async () => state.allowed) }))

import { PATCH as patchBank } from '@/app/api/portal/bank-accounts/route'
import { PATCH as patchCustomer, DELETE as deleteCustomer } from '@/app/api/portal/customers/[id]/route'
import { POST as postCustomer } from '@/app/api/portal/customers/route'
import { POST as postLogo } from '@/app/api/portal/logo/route'

const json = (method: string, url: string, body: unknown) => new NextRequest(url, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const updatesOf = (table: string) => fake.calls.filter(c => c.table === table && c.ops.some(o => o.m === 'update'))

beforeEach(() => { state.allowed = true; upload.mockClear() })

describe('bank accounts PATCH', () => {
  it('only whitelisted fields can change, and an unknown currency is refused', async () => {
    fake = makeFakeDb((c: Call) => (c.ops.some(o => o.m === 'maybeSingle') ? { data: { id: 'b1' } } : { data: { id: 'b1' } }))
    expect((await patchBank(json('PATCH', 'http://x/api/portal/bank-accounts', { id: 'b1', account_id: 'acc', currency: 'GBP' }))).status).toBe(400)
    expect(fake.writes().length).toBe(0)
  })
  it('ignores fields it does not know (no mass assignment)', async () => {
    fake = makeFakeDb(() => ({ data: { id: 'b1' } }))
    await patchBank(json('PATCH', 'http://x/api/portal/bank-accounts', { id: 'b1', account_id: 'acc', label: ' New ', account_id_override: 'other', created_at: '2000-01-01', iban: ' IT60 ' }))
    const payload = opArgs(updatesOf('client_bank_accounts')[0], 'update')![0] as Record<string, unknown>
    expect(payload).toEqual({ label: 'New', iban: 'IT60' })
  })
  it("another company's account is a 404 and nothing is touched (the others' show_on_invoice flag is not cleared)", async () => {
    fake = makeFakeDb(() => ({ data: null }))
    const res = await patchBank(json('PATCH', 'http://x/api/portal/bank-accounts', { id: 'foreign', account_id: 'acc', show_on_invoice: true }))
    expect(res.status).toBe(404)
    expect(fake.writes().length).toBe(0)
  })
  it('switching show_on_invoice on clears only the OTHER accounts of this company', async () => {
    fake = makeFakeDb(() => ({ data: { id: 'b1' } }))
    await patchBank(json('PATCH', 'http://x/api/portal/bank-accounts', { id: 'b1', account_id: 'acc', show_on_invoice: true }))
    const ups = updatesOf('client_bank_accounts')
    expect(hasOp(ups[0], 'neq', 'id', 'b1')).toBe(true)
    expect(hasOp(ups[0], 'eq', 'account_id', 'acc')).toBe(true)
  })
})

describe('customers', () => {
  it('a rename that sends only the first name keeps the last name', async () => {
    fake = makeFakeDb(c => (c.ops.some(o => o.m === 'single') ? { data: { account_id: 'acc', first_name: 'Mario', last_name: 'Rossi', company_name: null } } : { data: [] }))
    await patchCustomer(json('PATCH', 'http://x/api/portal/customers/c1', { first_name: 'Marco' }), { params: Promise.resolve({ id: 'c1' }) })
    const payload = opArgs(updatesOf('client_customers')[0], 'update')![0] as Record<string, unknown>
    expect(payload.name).toBe('Marco Rossi')
  })
  it('refuses an email address that could be used to inject headers', async () => {
    fake = makeFakeDb(c => (c.ops.some(o => o.m === 'single') ? { data: { account_id: 'acc', first_name: 'M', last_name: 'R', company_name: null } } : { data: [] }))
    const res = await patchCustomer(json('PATCH', 'http://x/api/portal/customers/c1', { email: 'a@b.co\r\nBcc: x@y.z' }), { params: Promise.resolve({ id: 'c1' }) })
    expect(res.status).toBe(400)
    expect(fake.writes().length).toBe(0)
    fake = makeFakeDb(() => ({ data: { id: 'n' } }))
    const res2 = await postCustomer(json('POST', 'http://x/api/portal/customers', { account_id: 'acc', name: 'X', email: 'not an email' }))
    expect(res2.status).toBe(400)
  })
  it('deleting still goes through the ownership check', async () => {
    fake = makeFakeDb(() => ({ data: null }))
    const res = await deleteCustomer(new NextRequest('http://x/api/portal/customers/c1', { method: 'DELETE' }), { params: Promise.resolve({ id: 'c1' }) })
    expect(res.status).toBe(404)
  })
})

describe('logo upload', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  function form(bytes: Buffer, type: string, name = 'logo.png') {
    const fd = new FormData()
    fd.set('file', new File([new Uint8Array(bytes)], name, { type }))
    fd.set('account_id', 'acc')
    return new NextRequest('http://x/api/portal/logo', { method: 'POST', body: fd })
  }
  it.each([['image/svg+xml'], ['image/webp'], ['text/html']])('refuses %s (the invoice PDF cannot embed it)', async (type) => {
    fake = makeFakeDb(() => ({ data: [] }))
    expect((await postLogo(form(PNG, type))).status).toBe(400)
    expect(upload).not.toHaveBeenCalled()
  })
  it('refuses a file that says PNG but is not one', async () => {
    fake = makeFakeDb(() => ({ data: [] }))
    expect((await postLogo(form(Buffer.from('<svg onload=alert(1)>'), 'image/png'))).status).toBe(400)
    expect(upload).not.toHaveBeenCalled()
  })
  it('stores a real PNG under an extension taken from the validated type, with a versioned URL', async () => {
    fake = makeFakeDb(() => ({ data: [] }))
    const res = await postLogo(form(PNG, 'image/png', 'evil.html'))
    expect(res.status).toBe(200)
    expect((upload.mock.calls[0] as unknown as [string])[0]).toBe('portal-logos/acc.png')
    expect((await res.json()).url).toMatch(/portal-logos\/acc\.png\?v=\d+/)
  })
})
