import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDb, type Call } from './helpers/fake-supabase'

let fake = makeFakeDb(() => undefined)
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: (t: string) => fake.db.from(t) } }))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u', app_metadata: { role: 'client' } } } }) }, from: () => ({ insert: () => Promise.resolve({ error: null }) }) }) }))
vi.mock('@/lib/portal/team/gate', () => ({ canAccessAccount: vi.fn(async () => true) }))
vi.mock('@/lib/portal-auth', () => ({ getClientContactId: () => null }))
vi.mock('@/app/portal/invoices/vendor-actions', () => ({ listVendors: vi.fn(async () => []), createVendor: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { createExpense } from '@/app/portal/invoices/expense-actions'

const base = { account_id: 'acc', vendor_name: 'Netlify', currency: 'USD' as const, total: 13.99 }
function script(vendorOwned: boolean) {
  return (c: Call) => {
    if (c.table === 'client_vendors') return { data: vendorOwned ? { id: 'v1' } : null }
    if (c.table === 'client_expenses' && c.ops.some(o => o.m === 'insert')) return { data: { id: 'e1' } }
    return { data: [] }
  }
}

beforeEach(() => { fake = makeFakeDb(script(true)) })

describe('createExpense validates on the server', () => {
  it.each([[-1], [NaN], [Infinity]])('refuses a total of %s', async (total) => {
    const r = await createExpense({ ...base, total })
    expect(r).toMatchObject({ success: false })
    expect(fake.writes().length).toBe(0)
  })
  it('refuses a currency or source the app does not support', async () => {
    expect(await createExpense({ ...base, currency: 'GBP' as never })).toMatchObject({ success: false })
    expect(await createExpense({ ...base, source: 'td_invoice' as never })).toMatchObject({ success: false })
  })
  it('refuses malformed dates', async () => {
    expect(await createExpense({ ...base, issue_date: 'tomorrow' })).toMatchObject({ success: false })
  })
  it("refuses a supplier of another company", async () => {
    fake = makeFakeDb(script(false))
    expect(await createExpense({ ...base, vendor_id: 'foreign' })).toMatchObject({ success: false })
    expect(fake.writes().length).toBe(0)
  })
  it('saves a valid expense with the company supplier', async () => {
    const r = await createExpense({ ...base, vendor_id: 'v1' })
    expect(r, JSON.stringify(r)).toMatchObject({ success: true })
  })
})
