/**
 * The ownership guard for every client-invoicing server action (dev job 1a23f5f1, council review 2026-10-09).
 * R086: every new function in lib/ gets a test.
 */
import { describe, it, expect, vi } from 'vitest'
import type { User } from '@supabase/supabase-js'

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }))
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))
vi.mock('@/lib/portal/team/gate', () => ({ canAccessAccount: vi.fn() }))

import { authorizeAccount, authorizeInvoice, actorLabel, NOT_FOUND, DENIED, NOT_SIGNED_IN, type AccessDeps } from '@/lib/portal/invoice-access'

const client = { id: 'u1', email: 'mario@rossi.it', app_metadata: { role: 'client' } } as unknown as User

function deps(over: Partial<AccessDeps> = {}): AccessDeps {
  return {
    getUser: async () => client,
    canAccess: async () => true,
    loadInvoiceAccount: async () => 'acc-1',
    ...over,
  }
}

describe('authorizeAccount', () => {
  it('refuses a caller who is not signed in', async () => {
    expect(await authorizeAccount('acc-1', 'invoices_billing', deps({ getUser: async () => null }))).toEqual({ ok: false, error: NOT_SIGNED_IN })
  })
  it('refuses a missing company id', async () => {
    expect(await authorizeAccount(null, 'invoices_billing', deps())).toEqual({ ok: false, error: DENIED })
    expect(await authorizeAccount('', 'invoices_billing', deps())).toEqual({ ok: false, error: DENIED })
  })
  it('refuses when the gate says no', async () => {
    expect(await authorizeAccount('acc-2', 'invoices_billing', deps({ canAccess: async () => false }))).toEqual({ ok: false, error: DENIED })
  })
  it('passes the capability and company to the gate and returns the company', async () => {
    const canAccess = vi.fn(async () => true)
    const r = await authorizeAccount('acc-9', 'sales_customers', deps({ canAccess }))
    expect(canAccess).toHaveBeenCalledWith(client, 'acc-9', 'sales_customers')
    expect(r).toMatchObject({ ok: true, accountId: 'acc-9' })
  })
})

describe('authorizeInvoice — the company comes from the STORED invoice', () => {
  it('asks the gate about the stored company, never anything the caller sent', async () => {
    const canAccess = vi.fn(async () => true)
    const r = await authorizeInvoice('inv-1', 'invoices_billing', deps({ canAccess, loadInvoiceAccount: async () => 'stored-acc' }))
    expect(canAccess).toHaveBeenCalledWith(client, 'stored-acc', 'invoices_billing')
    expect(r).toMatchObject({ ok: true, accountId: 'stored-acc' })
  })
  it('a caller of ANOTHER company is denied and told "not found" (ids cannot be probed)', async () => {
    const r = await authorizeInvoice('inv-1', 'invoices_billing', deps({ canAccess: async () => false }))
    expect(r).toEqual({ ok: false, error: NOT_FOUND })
  })
  it('an invoice that does not exist gives the same answer as a denied one', async () => {
    const r = await authorizeInvoice('nope', 'invoices_billing', deps({ loadInvoiceAccount: async () => null }))
    expect(r).toEqual({ ok: false, error: NOT_FOUND })
  })
  it('refuses when not signed in and does not even look the invoice up', async () => {
    const loadInvoiceAccount = vi.fn(async () => 'acc-1')
    const r = await authorizeInvoice('inv-1', 'invoices_billing', deps({ getUser: async () => null, loadInvoiceAccount }))
    expect(r).toEqual({ ok: false, error: NOT_SIGNED_IN })
    expect(loadInvoiceAccount).not.toHaveBeenCalled()
  })
})

describe('actorLabel', () => {
  it('names the person for the audit trail', () => {
    expect(actorLabel(client)).toBe('client:mario')
    expect(actorLabel({ email: 'luca@tonydurante.us', app_metadata: { role: 'admin' } } as unknown as User)).toBe('staff:luca')
    expect(actorLabel({ app_metadata: {} } as unknown as User)).toBe('staff:unknown')
  })
})
