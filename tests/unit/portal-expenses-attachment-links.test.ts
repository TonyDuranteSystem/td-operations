/**
 * Unit tests for the signed-attachment-link resolution added to
 * getPortalExpenses / getPortalExpensesByContact (dev job 06e57270).
 *
 * Root cause fixed: the portal expense-upload flow used to store a
 * public-style URL for `attachment_url`, but the `portal-uploads` bucket is
 * private, so the link 404/errored for the client. The fix stores the
 * bucket-relative path in `attachment_storage_path` and resolves a fresh,
 * short-lived signed URL here, at read time, for every row — never trusting
 * a stored `attachment_url` at rest.
 *
 * R086: every new function in lib/ gets a unit test. getPortalExpenses
 * (account-scoped) previously had ZERO test coverage at all — added here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

let clientExpensesRows: unknown[] = []
let paymentsRows: unknown[] = []

function makeChain(table: string) {
  const settle = () => {
    if (table === 'client_expenses') return Promise.resolve({ data: clientExpensesRows, error: null })
    if (table === 'payments') return Promise.resolve({ data: paymentsRows, error: null })
    return Promise.resolve({ data: [], error: null })
  }
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn(() => settle()),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => settle().then(resolve, reject),
  }
  return chain
}

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: (table: string) => makeChain(table) },
}))

const createRecordedSignedUrl = vi.fn()
vi.mock('@/lib/storage/signed-download', () => ({ createRecordedSignedUrl }))

import { getPortalExpenses, getPortalExpensesByContact } from '@/lib/portal/queries'

beforeEach(() => {
  clientExpensesRows = []
  paymentsRows = []
  createRecordedSignedUrl.mockReset()
})

describe('getPortalExpenses — signed attachment links', () => {
  it('leaves a row with no attachment_storage_path untouched, and never signs it', async () => {
    clientExpensesRows = [
      { id: 'e1', source: 'manual', attachment_storage_path: null, attachment_url: null },
    ]
    const result = await getPortalExpenses('acct-1')
    expect(result).toEqual(clientExpensesRows)
    expect(createRecordedSignedUrl).not.toHaveBeenCalled()
  })

  it('replaces attachment_url with a freshly signed URL for a row that has attachment_storage_path', async () => {
    clientExpensesRows = [
      { id: 'e1', source: 'upload', attachment_storage_path: 'acct-1/file-a.pdf', attachment_url: 'stale-or-broken-value' },
    ]
    createRecordedSignedUrl.mockResolvedValue('https://signed.example/fresh-link')

    const result = await getPortalExpenses('acct-1')

    expect(createRecordedSignedUrl).toHaveBeenCalledWith('portal-uploads', 'acct-1/file-a.pdf', 3600)
    expect(result[0]).toMatchObject({ id: 'e1', attachment_url: 'https://signed.example/fresh-link' })
  })

  it('resolves every row needing a signature, not just the first', async () => {
    clientExpensesRows = [
      { id: 'e1', source: 'upload', attachment_storage_path: 'acct-1/a.pdf', attachment_url: null },
      { id: 'e2', source: 'upload', attachment_storage_path: 'acct-1/b.pdf', attachment_url: null },
      { id: 'e3', source: 'manual', attachment_storage_path: null, attachment_url: null },
    ]
    createRecordedSignedUrl.mockImplementation((_bucket: string, path: string) => Promise.resolve(`https://signed.example/${path}`))

    const result = await getPortalExpenses('acct-1')

    expect(createRecordedSignedUrl).toHaveBeenCalledTimes(2)
    expect(result.find(r => (r as { id: string }).id === 'e1')).toMatchObject({ attachment_url: 'https://signed.example/acct-1/a.pdf' })
    expect(result.find(r => (r as { id: string }).id === 'e2')).toMatchObject({ attachment_url: 'https://signed.example/acct-1/b.pdf' })
    expect(result.find(r => (r as { id: string }).id === 'e3')).toMatchObject({ attachment_url: null })
  })

  it('fails open: if signing fails (returns null), the row is returned unchanged rather than thrown/dropped', async () => {
    clientExpensesRows = [
      { id: 'e1', source: 'upload', attachment_storage_path: 'acct-1/a.pdf', attachment_url: 'old-broken-link' },
    ]
    createRecordedSignedUrl.mockResolvedValue(null)

    const result = await getPortalExpenses('acct-1')
    expect(result[0]).toMatchObject({ id: 'e1', attachment_url: 'old-broken-link' })
  })
})

describe('getPortalExpensesByContact — signed attachment links', () => {
  it('resolves a signed URL the same way for a contact-scoped (no-account) expense row', async () => {
    clientExpensesRows = [
      { id: 'e1', source: 'upload', attachment_storage_path: 'contact-1/receipt.pdf', attachment_url: null },
    ]
    createRecordedSignedUrl.mockResolvedValue('https://signed.example/contact-fresh-link')

    const result = await getPortalExpensesByContact('contact-1')

    expect(createRecordedSignedUrl).toHaveBeenCalledWith('portal-uploads', 'contact-1/receipt.pdf', 3600)
    expect(result[0]).toMatchObject({ id: 'e1', attachment_url: 'https://signed.example/contact-fresh-link' })
  })
})
