/**
 * Unit tests for the ownership check on the client-portal TD invoice PDF
 * download (dev job 3e4b490c). Before this fix, the route only recognized
 * account-based ownership (getClientAccountIds().includes(payment.account_id)),
 * so a "formation-gap" client — paid TD as an individual, no company/account
 * yet — always got a 403 on their own invoice, because payment.account_id is
 * null and their account list is always empty. Confirmed live: 45 payments /
 * 36 distinct contacts in this exact state.
 *
 * The fix mirrors assertOwnsExpense (app/portal/invoices/expense-actions.ts):
 * allow if the caller owns the account (via canAccessAccount, which also
 * recognizes a Portal Team Access teammate granted invoices_billing — the
 * older getClientAccountIds check silently 403'd them too), OR the payment
 * is contact-scoped and the contact_id matches the caller. These tests pin
 * both halves, plus the Bill-To fallback to the contact's own name when
 * there's no company to pull one from.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

const { getUser, canAccessAccount, getClientContactId, generateInvoicePdf } = vi.hoisted(() => ({
  getUser: vi.fn(),
  canAccessAccount: vi.fn(),
  getClientContactId: vi.fn(),
  generateInvoicePdf: vi.fn(async () => new Uint8Array([1, 2, 3])),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser } }),
}))
vi.mock('@/lib/portal/team/gate', () => ({ canAccessAccount }))
vi.mock('@/lib/portal-auth', () => ({ getClientContactId }))
vi.mock('@/lib/pdf/invoice-pdf', () => ({ generateInvoicePdf }))

let paymentRow: Record<string, unknown> | null = null
let accountRow: Record<string, unknown> | null = null
let accountContactRow: Record<string, unknown> | null = null
let directContactRow: Record<string, unknown> | null = null
let itemRows: Array<Record<string, unknown>> = []

function makeChain(table: string) {
  const chain: Record<string, unknown> = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    not: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    order: vi.fn(() => Promise.resolve({ data: itemRows, error: null })),
    single: vi.fn(() => {
      if (table === 'payments') return Promise.resolve({ data: paymentRow, error: null })
      if (table === 'accounts') return Promise.resolve({ data: accountRow, error: null })
      return Promise.resolve({ data: null, error: null })
    }),
    maybeSingle: vi.fn(() => {
      if (table === 'account_contacts') return Promise.resolve({ data: accountContactRow, error: null })
      if (table === 'contacts') return Promise.resolve({ data: directContactRow, error: null })
      return Promise.resolve({ data: null, error: null })
    }),
  }
  return chain
}

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: (table: string) => makeChain(table) },
}))

import { GET } from '@/app/api/portal/payments/[id]/pdf/route'

const authedUser = { id: 'u1', app_metadata: { role: 'client' } }

function fakeRequest(): NextRequest {
  return {} as unknown as NextRequest
}

async function callRoute(id = 'pay-1') {
  return GET(fakeRequest(), { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  getUser.mockReset()
  canAccessAccount.mockReset()
  getClientContactId.mockReset()
  generateInvoicePdf.mockClear()
  paymentRow = null
  accountRow = null
  accountContactRow = null
  directContactRow = null
  itemRows = []
  getUser.mockResolvedValue({ data: { user: authedUser } })
})

describe('GET /api/portal/payments/[id]/pdf — access control', () => {
  it('rejects when unauthenticated', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    const res = await callRoute()
    expect(res.status).toBe(401)
    expect(canAccessAccount).not.toHaveBeenCalled()
  })

  it('404s when the invoice does not exist', async () => {
    paymentRow = null
    const res = await callRoute()
    expect(res.status).toBe(404)
  })

  it('denies an account-scoped invoice when the caller does not own the account', async () => {
    paymentRow = { id: 'pay-1', account_id: 'someone-elses-account', contact_id: null, invoice_status: 'Paid' }
    canAccessAccount.mockResolvedValue(false)
    getClientContactId.mockReturnValue('contact-1')
    const res = await callRoute()
    expect(res.status).toBe(403)
    expect(canAccessAccount).toHaveBeenCalledWith(authedUser, 'someone-elses-account', 'invoices_billing')
  })

  it('allows an account-scoped invoice when the caller owns the account (regression check)', async () => {
    paymentRow = { id: 'pay-1', account_id: 'my-account', contact_id: null, invoice_status: 'Paid', amount_currency: 'USD' }
    accountRow = { company_name: 'My Company LLC', physical_address: null, ein_number: null, mailing_address: null }
    canAccessAccount.mockResolvedValue(true)
    getClientContactId.mockReturnValue(null)
    const res = await callRoute()
    expect(res.status).toBe(200)
    expect(generateInvoicePdf).toHaveBeenCalledWith(expect.objectContaining({
      billTo: expect.objectContaining({ name: 'My Company LLC' }),
    }))
  })

  it('THE FIX: allows a contact-scoped invoice (no account yet) when the caller is the exact owning contact', async () => {
    paymentRow = { id: 'pay-1', account_id: null, contact_id: 'contact-1', invoice_status: 'Paid', amount_currency: 'EUR' }
    directContactRow = { first_name: 'Francesco', last_name: 'Lussignoli', email: 'francesco@example.com' }
    canAccessAccount.mockResolvedValue(false) // no account_id, so this is always false — access must come from the contact branch
    getClientContactId.mockReturnValue('contact-1')
    const res = await callRoute()
    expect(res.status).toBe(200)
    expect(generateInvoicePdf).toHaveBeenCalledWith(expect.objectContaining({
      billTo: expect.objectContaining({ name: 'Francesco Lussignoli', email: 'francesco@example.com' }),
    }))
  })

  it('denies a contact-scoped invoice for a DIFFERENT contact, even if authenticated', async () => {
    paymentRow = { id: 'pay-1', account_id: null, contact_id: 'contact-1', invoice_status: 'Paid' }
    canAccessAccount.mockResolvedValue(false)
    getClientContactId.mockReturnValue('contact-2')
    const res = await callRoute()
    expect(res.status).toBe(403)
  })

  it('denies a contact-scoped invoice for a teammate (no contact id at all)', async () => {
    paymentRow = { id: 'pay-1', account_id: null, contact_id: 'contact-1', invoice_status: 'Paid' }
    canAccessAccount.mockResolvedValue(false)
    getClientContactId.mockReturnValue(null)
    const res = await callRoute()
    expect(res.status).toBe(403)
  })

  it('allows a Portal Team Access teammate (no contact id) with the invoices_billing capability on an account-scoped invoice', async () => {
    paymentRow = { id: 'pay-1', account_id: 'their-account', contact_id: null, invoice_status: 'Paid', amount_currency: 'USD' }
    accountRow = { company_name: 'Their Company LLC', physical_address: null, ein_number: null, mailing_address: null }
    canAccessAccount.mockResolvedValue(true) // teammate granted invoices_billing for their-account
    getClientContactId.mockReturnValue(null) // teammates have no contact_id
    const res = await callRoute()
    expect(res.status).toBe(200)
  })

  it('falls back to the generic "Client" bill-to name when neither an account nor a contact can be resolved', async () => {
    paymentRow = { id: 'pay-1', account_id: null, contact_id: 'contact-1', invoice_status: 'Paid' }
    directContactRow = null // contact row missing/deleted, but the id still matches
    canAccessAccount.mockResolvedValue(false)
    getClientContactId.mockReturnValue('contact-1')
    const res = await callRoute()
    expect(res.status).toBe(200)
    expect(generateInvoicePdf).toHaveBeenCalledWith(expect.objectContaining({
      billTo: expect.objectContaining({ name: 'Client' }),
    }))
  })
})
