import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { makeFakeDb, hasOp, opArgs, type Call } from './helpers/fake-supabase'

const state = vi.hoisted(() => ({ allowed: true }))
let fake = makeFakeDb(() => undefined)
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: (t: string) => fake.db.from(t) } }))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u', app_metadata: { role: 'client' } } } }) } }) }))
vi.mock('@/lib/portal/team/gate', () => ({ canAccessAccount: vi.fn(async () => state.allowed) }))

import { POST, PATCH, DELETE } from '@/app/api/portal/payment-links/route'

const json = (method: string, body: unknown) => new NextRequest('http://x/api/portal/payment-links', { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const del = (qs: string) => new NextRequest(`http://x/api/portal/payment-links?${qs}`, { method: 'DELETE' })
const updates = () => fake.calls.filter(c => c.ops.some(o => o.m === 'update'))

beforeEach(() => { state.allowed = true })

describe('POST', () => {
  const ok = { account_id: 'acc', label: 'Stripe', url: 'https://buy.stripe.com/abc123', gateway: 'stripe' }
  it.each([['javascript:alert(1)'], ['http://insecure.example.com/pay'], ['https://x.com/"><script>']])('refuses the link %s', async (url) => {
    fake = makeFakeDb(() => ({ data: [] }))
    const res = await POST(json('POST', { ...ok, url }))
    expect(res.status).toBe(400)
    expect(fake.writes().length).toBe(0)
  })
  it('the first link becomes the default, set in the safe order (new one first, then clear the others)', async () => {
    fake = makeFakeDb((c: Call) => {
      if (c.ops.some(o => o.m === 'insert')) return { data: { id: 'new', is_default: false } }
      if (c.ops.some(o => o.m === 'select' && (o.args[1] as { head?: boolean })?.head)) return { count: 0 }
      return { data: [] }
    })
    const res = await POST(json('POST', ok))
    expect((await res.json()).is_default).toBe(true)
    const ups = updates()
    expect(opArgs(ups[0], 'update')![0]).toEqual({ is_default: true })
    expect(hasOp(ups[0], 'eq', 'id', 'new')).toBe(true)
    expect(opArgs(ups[1], 'update')![0]).toEqual({ is_default: false })
    expect(hasOp(ups[1], 'neq', 'id', 'new')).toBe(true)
  })
  it('denies a caller outside the company', async () => {
    state.allowed = false
    fake = makeFakeDb(() => ({ data: [] }))
    expect((await POST(json('POST', ok))).status).toBe(403)
  })
})

describe('PATCH — set default', () => {
  it("another company's link id is refused BEFORE anything is cleared (the caller keeps their own default)", async () => {
    fake = makeFakeDb(() => ({ data: null })) // the link is not in this account
    const res = await PATCH(json('PATCH', { id: 'foreign-link', account_id: 'acc', is_default: true }))
    expect(res.status).toBe(404)
    expect(fake.writes().length).toBe(0)
  })
  it('a link of this company becomes the default', async () => {
    fake = makeFakeDB_forOwnLink()
    const res = await PATCH(json('PATCH', { id: 'mine', account_id: 'acc', is_default: true }))
    expect(res.status).toBe(200)
    const ups = updates()
    expect(hasOp(ups[0], 'eq', 'account_id', 'acc')).toBe(true)
    expect(hasOp(ups[0], 'eq', 'id', 'mine')).toBe(true)
  })
})
function makeFakeDB_forOwnLink() {
  return makeFakeDb(c => (c.ops.some(o => o.m === 'maybeSingle') ? { data: { id: 'mine' } } : { data: [] }))
}

describe('DELETE', () => {
  it('deleting the default promotes the oldest remaining link', async () => {
    fake = makeFakeDb(c => {
      if (c.ops.some(o => o.m === 'maybeSingle')) return { data: { id: 'old-default', is_default: true } }
      if (c.ops.some(o => o.m === 'select' && o.args[0] === 'id, created_at')) return { data: [{ id: 'b', created_at: '2026-03-01' }, { id: 'a', created_at: '2026-01-01' }] }
      return { data: [] }
    })
    const res = await DELETE(del('id=old-default&account_id=acc'))
    expect(res.status).toBe(200)
    expect(fake.calls.some(c => c.ops.some(o => o.m === 'delete'))).toBe(true)
    const promote = updates()[0]
    expect(opArgs(promote, 'update')![0]).toEqual({ is_default: true })
    expect(hasOp(promote, 'eq', 'id', 'a')).toBe(true)
  })
  it('deleting a link that is not this company\'s is a 404 and deletes nothing', async () => {
    fake = makeFakeDb(() => ({ data: null }))
    const res = await DELETE(del('id=x&account_id=acc'))
    expect(res.status).toBe(404)
    expect(fake.writes().length).toBe(0)
  })
  it('deleting the only link just deletes it', async () => {
    fake = makeFakeDb(c => {
      if (c.ops.some(o => o.m === 'maybeSingle')) return { data: { id: 'only', is_default: true } }
      return { data: [] }
    })
    expect((await DELETE(del('id=only&account_id=acc'))).status).toBe(200)
    expect(updates().length).toBe(0)
  })
})
