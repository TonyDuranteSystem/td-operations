/**
 * Unit tests for the ownership check added to the client-facing vendor
 * (Suppliers) actions (dev job 06e57270, follow-up to the expense-actions
 * ownership fix). Before this fix, createVendor/updateVendor/deleteVendor
 * had NO check that the logged-in caller owned the account a vendor
 * belonged to — any authenticated portal session could create/edit/delete a
 * DIFFERENT client's vendor by supplying or guessing its id.
 *
 * Unlike client_expenses, client_vendors has no contact-only mode (every row
 * requires a real account_id) — so this is a single-branch check, not the
 * dual account/contact shape used for expenses. These tests also pin that
 * distinction: there is no contact-scoped success path to test here.
 *
 * R086: every new function in lib/ (and app/ server actions) gets a test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { getUser, canAccessAccount } = vi.hoisted(() => ({
  getUser: vi.fn(),
  canAccessAccount: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser },
    from: () => ({ insert: () => Promise.resolve({ error: null }) }),
  }),
}))

vi.mock('@/lib/portal/team/gate', () => ({ canAccessAccount }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

let vendorRow: { account_id: string } | null = null
let linkedExpenseCount = 0
let updateCalled = false
let deleteCalled = false
let insertCalled = false

function makeVendorChain() {
  const chain: Record<string, unknown> = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    single: vi.fn(() => Promise.resolve({ data: vendorRow, error: null })),
    update: vi.fn(() => { updateCalled = true; return chain }),
    delete: vi.fn(() => { deleteCalled = true; return chain }),
    insert: vi.fn(() => { insertCalled = true; return chain }),
  }
  chain.eq = vi.fn(() => (updateCalled || deleteCalled ? Promise.resolve({ error: null }) : chain))
  return chain
}

function makeExpenseCountChain() {
  const chain: Record<string, unknown> = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => Promise.resolve({ count: linkedExpenseCount, error: null })),
  }
  return chain
}

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => (table === 'client_expenses' ? makeExpenseCountChain() : makeVendorChain()),
  },
}))

import { createVendor, updateVendor, deleteVendor } from '@/app/portal/invoices/vendor-actions'

const authedUser = { id: 'u1', app_metadata: { role: 'client' } }

beforeEach(() => {
  getUser.mockReset()
  canAccessAccount.mockReset()
  vendorRow = null
  linkedExpenseCount = 0
  updateCalled = false
  deleteCalled = false
  insertCalled = false
})

describe('createVendor — ownership check', () => {
  it('rejects when unauthenticated', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    const res = await createVendor({ account_id: 'acct-1', name: 'Netlify' })
    expect(res).toMatchObject({ success: false, error: 'Unauthorized' })
    expect(insertCalled).toBe(false)
  })

  it('rejects when the caller does not own the target account', async () => {
    getUser.mockResolvedValue({ data: { user: authedUser } })
    canAccessAccount.mockResolvedValue(false)
    const res = await createVendor({ account_id: 'someone-elses-account', name: 'Netlify' })
    expect(res).toMatchObject({ success: false, error: 'Access denied' })
    expect(insertCalled).toBe(false)
    expect(canAccessAccount).toHaveBeenCalledWith(authedUser, 'someone-elses-account', 'invoices_billing')
  })

  it('proceeds when the caller owns the account', async () => {
    getUser.mockResolvedValue({ data: { user: authedUser } })
    canAccessAccount.mockResolvedValue(true)
    const res = await createVendor({ account_id: 'my-account', name: 'Netlify' })
    expect(res.success).toBe(true)
    expect(insertCalled).toBe(true)
  })
})

describe('updateVendor / deleteVendor — ownership check', () => {
  it('denies editing a vendor on an account the caller does not own', async () => {
    getUser.mockResolvedValue({ data: { user: authedUser } })
    vendorRow = { account_id: 'someone-elses-account' }
    canAccessAccount.mockResolvedValue(false)

    const res = await updateVendor('vendor-1', { name: 'New Name' })
    expect(res).toMatchObject({ success: false, error: 'Access denied' })
    expect(updateCalled).toBe(false)
  })

  it('denies deleting a vendor on an account the caller does not own', async () => {
    getUser.mockResolvedValue({ data: { user: authedUser } })
    vendorRow = { account_id: 'someone-elses-account' }
    canAccessAccount.mockResolvedValue(false)

    const res = await deleteVendor('vendor-1')
    expect(res).toMatchObject({ success: false, error: 'Access denied' })
    expect(deleteCalled).toBe(false)
  })

  it('allows editing when the caller owns the account', async () => {
    getUser.mockResolvedValue({ data: { user: authedUser } })
    vendorRow = { account_id: 'my-account' }
    canAccessAccount.mockResolvedValue(true)

    const res = await updateVendor('vendor-1', { name: 'New Name' })
    expect(res.success).toBe(true)
    expect(updateCalled).toBe(true)
  })

  it('allows deleting an unreferenced vendor when the caller owns the account', async () => {
    getUser.mockResolvedValue({ data: { user: authedUser } })
    vendorRow = { account_id: 'my-account' }
    canAccessAccount.mockResolvedValue(true)
    linkedExpenseCount = 0

    const res = await deleteVendor('vendor-1')
    expect(res.success).toBe(true)
    expect(deleteCalled).toBe(true)
  })

  it('still blocks deleting a vendor with linked expenses, even for the owning caller', async () => {
    getUser.mockResolvedValue({ data: { user: authedUser } })
    vendorRow = { account_id: 'my-account' }
    canAccessAccount.mockResolvedValue(true)
    linkedExpenseCount = 2

    const res = await deleteVendor('vendor-1')
    expect(res).toMatchObject({ success: false })
    expect(res.error).toMatch(/2 expense/)
    expect(deleteCalled).toBe(false)
  })

  it('reports a clean error rather than throwing when the vendor id does not exist', async () => {
    getUser.mockResolvedValue({ data: { user: authedUser } })
    vendorRow = null

    const res = await updateVendor('nonexistent', { name: 'X' })
    expect(res).toMatchObject({ success: false, error: 'Vendor not found' })
    expect(canAccessAccount).not.toHaveBeenCalled()
  })
})
