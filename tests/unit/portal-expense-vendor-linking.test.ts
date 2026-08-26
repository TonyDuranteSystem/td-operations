/**
 * Unit tests for the vendor find-or-create logic added to createExpense
 * (dev job 06e57270, follow-up to the receipt-link fix). Antonio caught it
 * live: a client-typed vendor name was never linked to a real vendor record,
 * so it never appeared in their own Suppliers list. These tests pin the fix:
 * an existing vendor is matched and reused (never duplicated), a new name
 * creates a real vendor record, matching is exact/case-insensitive (never a
 * database LIKE-style match, which would treat `%`/`_` in a typed name as
 * wildcards and could silently attach the expense to the WRONG vendor), and
 * the expense still saves even if the vendor-linking step has trouble.
 *
 * R086: every new function in lib/ (and app/ server actions) gets a test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { getUser, canAccessAccount, listVendors, createVendor } = vi.hoisted(() => ({
  getUser: vi.fn(),
  canAccessAccount: vi.fn(),
  listVendors: vi.fn(),
  createVendor: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser },
    from: () => ({ insert: () => Promise.resolve({ error: null }) }),
  }),
}))

vi.mock('@/lib/portal/team/gate', () => ({ canAccessAccount }))
vi.mock('@/lib/portal-auth', () => ({ getClientContactId: () => null }))
vi.mock('@/app/portal/invoices/vendor-actions', () => ({ listVendors, createVendor }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

let insertedRow: Record<string, unknown> | null = null

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (_table: string) => {
      const chain: Record<string, unknown> = {
        select: vi.fn(() => chain),
        like: vi.fn(() => chain),
        order: vi.fn(() => chain),
        limit: vi.fn(() => Promise.resolve({ data: [], error: null })),
        insert: vi.fn((row: Record<string, unknown>) => { insertedRow = row; return chain }),
        single: vi.fn(() => Promise.resolve({ data: { id: 'exp-1' }, error: null })),
      }
      return chain
    },
  },
}))

import { createExpense } from '@/app/portal/invoices/expense-actions'

const authedUser = { id: 'u1', app_metadata: { role: 'client' } }

beforeEach(() => {
  getUser.mockReset()
  canAccessAccount.mockReset()
  listVendors.mockReset()
  createVendor.mockReset()
  insertedRow = null
  getUser.mockResolvedValue({ data: { user: authedUser } })
  canAccessAccount.mockResolvedValue(true)
})

describe('createExpense — vendor find-or-create', () => {
  it('reuses an existing vendor matched by exact name, never creating a duplicate', async () => {
    listVendors.mockResolvedValue([{ id: 'v-existing', name: 'Netlify', account_id: 'acct-1' }])

    await createExpense({ account_id: 'acct-1', vendor_name: 'Netlify', currency: 'USD', total: 13.99 })

    expect(createVendor).not.toHaveBeenCalled()
    expect(insertedRow?.vendor_id).toBe('v-existing')
  })

  it('matches an existing vendor case-insensitively and with surrounding whitespace trimmed', async () => {
    listVendors.mockResolvedValue([{ id: 'v-existing', name: 'Netlify', account_id: 'acct-1' }])

    await createExpense({ account_id: 'acct-1', vendor_name: '  NETLIFY  ', currency: 'USD', total: 13.99 })

    expect(createVendor).not.toHaveBeenCalled()
    expect(insertedRow?.vendor_id).toBe('v-existing')
  })

  it('does NOT match via database wildcard semantics — a typed name containing % or _ only matches its literal self', async () => {
    // A vendor already exists whose name, if treated as a LIKE/ILIKE pattern, would
    // match almost anything. The lookup must compare literal strings, not patterns.
    listVendors.mockResolvedValue([{ id: 'v-wildcard', name: '50% Vendor', account_id: 'acct-1' }])
    createVendor.mockResolvedValue({ success: true, data: { id: 'v-new' } })

    await createExpense({ account_id: 'acct-1', vendor_name: 'Anything Else', currency: 'USD', total: 10 })

    // Must NOT have matched the "50% Vendor" row — a real new vendor gets created instead.
    expect(createVendor).toHaveBeenCalledWith({ account_id: 'acct-1', name: 'Anything Else' })
    expect(insertedRow?.vendor_id).toBe('v-new')
  })

  it('creates a new vendor when no existing name matches, and links the new id to the expense', async () => {
    listVendors.mockResolvedValue([])
    createVendor.mockResolvedValue({ success: true, data: { id: 'v-new' } })

    await createExpense({ account_id: 'acct-1', vendor_name: 'Netlify', currency: 'USD', total: 13.99 })

    expect(createVendor).toHaveBeenCalledWith({ account_id: 'acct-1', name: 'Netlify' })
    expect(insertedRow?.vendor_id).toBe('v-new')
  })

  it('is fail-open: if vendor creation fails, the expense still saves with no vendor link', async () => {
    listVendors.mockResolvedValue([])
    createVendor.mockResolvedValue({ success: false, error: 'boom' })

    const res = await createExpense({ account_id: 'acct-1', vendor_name: 'Netlify', currency: 'USD', total: 13.99 })

    expect(res.success).toBe(true)
    expect(insertedRow?.vendor_id).toBeNull()
  })

  it('is fail-open: if the vendor lookup itself throws, the expense still saves with no vendor link', async () => {
    listVendors.mockRejectedValue(new Error('network blip'))

    const res = await createExpense({ account_id: 'acct-1', vendor_name: 'Netlify', currency: 'USD', total: 13.99 })

    expect(res.success).toBe(true)
    expect(insertedRow?.vendor_id).toBeNull()
  })

  it('skips the lookup entirely when the caller already passed an explicit vendor_id (existing-vendor dropdown path)', async () => {
    await createExpense({ account_id: 'acct-1', vendor_id: 'v-picked', vendor_name: 'Netlify', currency: 'USD', total: 13.99 })

    expect(listVendors).not.toHaveBeenCalled()
    expect(createVendor).not.toHaveBeenCalled()
    expect(insertedRow?.vendor_id).toBe('v-picked')
  })

  it('leaves vendor_id null for a blank vendor name rather than creating a blank-named vendor', async () => {
    const res = await createExpense({ account_id: 'acct-1', vendor_name: '   ', currency: 'USD', total: 13.99 })

    expect(res.success).toBe(true)
    expect(createVendor).not.toHaveBeenCalled()
    expect(insertedRow?.vendor_id).toBeNull()
  })
})
