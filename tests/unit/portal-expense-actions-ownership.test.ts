/**
 * Unit tests for the ownership check added to the client-facing expense
 * actions (dev job 06e57270, Senior Engineer council finding — BLOCKER).
 *
 * Before this fix, createExpense/updateExpense/markExpensePaid/deleteExpense
 * only checked `source !== 'td_invoice'` — never that the logged-in caller
 * actually owns the account/contact the expense belongs to. Any authenticated
 * portal session could write/edit/delete/mark-paid a DIFFERENT client's
 * self-logged expense by supplying its id. These tests pin the fix: denied
 * unless the caller owns the account (account-scoped rows) or is the exact
 * owning contact (contact-scoped, no-account rows) — never a teammate.
 *
 * R086: every new function in lib/ gets a unit test — assertOwnsExpense is
 * new, and it gates real client data, so it gets thorough coverage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { getUser, canAccessAccount, getClientContactId } = vi.hoisted(() => ({
  getUser: vi.fn(),
  canAccessAccount: vi.fn(),
  getClientContactId: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser },
    from: () => ({ insert: () => Promise.resolve({ error: null }) }),
  }),
}))

vi.mock('@/lib/portal/team/gate', () => ({ canAccessAccount }))

vi.mock('@/lib/portal-auth', () => ({ getClientContactId }))

let expenseRow: { source: string; account_id: string | null; contact_id: string | null } | null = null
let updateCalled = false
let deleteCalled = false
let insertCalled = false

function makeChain() {
  const chain: Record<string, unknown> = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    like: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve({ data: [], error: null })),
    single: vi.fn(() => Promise.resolve({ data: expenseRow, error: null })),
    update: vi.fn(() => { updateCalled = true; return chain }),
    delete: vi.fn(() => { deleteCalled = true; return chain }),
    insert: vi.fn(() => { insertCalled = true; return chain }),
  }
  // .update(...).eq(...) and .delete().eq(...) resolve directly (no .single())
  chain.eq = vi.fn(() => (updateCalled || deleteCalled ? Promise.resolve({ error: null }) : chain))
  return chain
}

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: () => makeChain() },
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { createExpense, updateExpense, markExpensePaid, deleteExpense } from '@/app/portal/invoices/expense-actions'

const authedUser = { id: 'u1', app_metadata: { role: 'client' } }

beforeEach(() => {
  getUser.mockReset()
  canAccessAccount.mockReset()
  getClientContactId.mockReset()
  expenseRow = null
  updateCalled = false
  deleteCalled = false
  insertCalled = false
})

describe('createExpense — ownership check', () => {
  it('rejects when unauthenticated', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    const res = await createExpense({ account_id: 'acct-1', vendor_name: 'V', currency: 'USD', total: 10 })
    expect(res).toMatchObject({ success: false, error: 'Unauthorized' })
    expect(insertCalled).toBe(false)
  })

  it('rejects when the caller does not own the target account', async () => {
    getUser.mockResolvedValue({ data: { user: authedUser } })
    canAccessAccount.mockResolvedValue(false)
    const res = await createExpense({ account_id: 'someone-elses-account', vendor_name: 'V', currency: 'USD', total: 10 })
    expect(res).toMatchObject({ success: false, error: 'Access denied' })
    expect(insertCalled).toBe(false)
    expect(canAccessAccount).toHaveBeenCalledWith(authedUser, 'someone-elses-account', 'invoices_billing')
  })

  it('proceeds when the caller owns the account', async () => {
    getUser.mockResolvedValue({ data: { user: authedUser } })
    canAccessAccount.mockResolvedValue(true)
    const res = await createExpense({ account_id: 'my-account', vendor_name: 'V', currency: 'USD', total: 10 })
    expect(res.success).toBe(true)
    expect(insertCalled).toBe(true)
  })
})

describe('updateExpense / markExpensePaid / deleteExpense — ownership check', () => {
  it('denies editing an expense on an account the caller does not own', async () => {
    getUser.mockResolvedValue({ data: { user: authedUser } })
    expenseRow = { source: 'upload', account_id: 'someone-elses-account', contact_id: null }
    canAccessAccount.mockResolvedValue(false)

    const res = await updateExpense('exp-1', { total: 1 })
    expect(res).toMatchObject({ success: false, error: 'Access denied' })
    expect(updateCalled).toBe(false)
  })

  it('denies marking paid an expense on an account the caller does not own', async () => {
    getUser.mockResolvedValue({ data: { user: authedUser } })
    expenseRow = { source: 'upload', account_id: 'someone-elses-account', contact_id: null }
    canAccessAccount.mockResolvedValue(false)

    const res = await markExpensePaid('exp-1')
    expect(res).toMatchObject({ success: false, error: 'Access denied' })
    expect(updateCalled).toBe(false)
  })

  it('denies deleting an expense on an account the caller does not own', async () => {
    getUser.mockResolvedValue({ data: { user: authedUser } })
    expenseRow = { source: 'manual', account_id: 'someone-elses-account', contact_id: null }
    canAccessAccount.mockResolvedValue(false)

    const res = await deleteExpense('exp-1')
    expect(res).toMatchObject({ success: false, error: 'Access denied' })
    expect(deleteCalled).toBe(false)
  })

  it('allows deleting when the caller owns the account', async () => {
    getUser.mockResolvedValue({ data: { user: authedUser } })
    expenseRow = { source: 'manual', account_id: 'my-account', contact_id: null }
    canAccessAccount.mockResolvedValue(true)

    const res = await deleteExpense('exp-1')
    expect(res.success).toBe(true)
    expect(deleteCalled).toBe(true)
  })

  it('contact-scoped row: allows the exact owning contact, even though there is no account to check', async () => {
    getUser.mockResolvedValue({ data: { user: authedUser } })
    expenseRow = { source: 'manual', account_id: null, contact_id: 'contact-1' }
    getClientContactId.mockReturnValue('contact-1')

    const res = await deleteExpense('exp-1')
    expect(res.success).toBe(true)
    expect(canAccessAccount).not.toHaveBeenCalled()
  })

  it('contact-scoped row: denies a DIFFERENT contact, even if authenticated', async () => {
    getUser.mockResolvedValue({ data: { user: authedUser } })
    expenseRow = { source: 'manual', account_id: null, contact_id: 'contact-1' }
    getClientContactId.mockReturnValue('contact-2')

    const res = await deleteExpense('exp-1')
    expect(res).toMatchObject({ success: false, error: 'Access denied' })
    expect(deleteCalled).toBe(false)
  })

  it('contact-scoped row: denies a teammate (no contact id at all), never falls through to allow', async () => {
    getUser.mockResolvedValue({ data: { user: authedUser } })
    expenseRow = { source: 'manual', account_id: null, contact_id: 'contact-1' }
    getClientContactId.mockReturnValue(null)

    const res = await deleteExpense('exp-1')
    expect(res).toMatchObject({ success: false, error: 'Access denied' })
    expect(deleteCalled).toBe(false)
  })

  it('the td_invoice business-rule guard still applies for an owner acting on their own TD-invoice mirror', async () => {
    getUser.mockResolvedValue({ data: { user: authedUser } })
    expenseRow = { source: 'td_invoice', account_id: 'my-account', contact_id: null }
    canAccessAccount.mockResolvedValue(true)

    const res = await deleteExpense('exp-1')
    expect(res).toMatchObject({ success: false, error: 'Cannot delete TD invoices' })
    expect(deleteCalled).toBe(false)
  })
})
