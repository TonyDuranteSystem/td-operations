/**
 * test_cleanup must never sweep away a permanent QA fixture, and must never
 * report success on a delete that actually failed. Both were real bugs found
 * during the 2026-08-28 full E2E QA pass: the dry run listed Uxio Test LLC
 * (CLAUDE.md's documented permanent portal-login fixture) for deletion, and
 * a real confirm=true run reported "Removed 0 records" while every row was
 * still present — because two deletes failed on an unlisted foreign key and
 * the old code silently coerced any error to a count of 0.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: vi.fn(),
  },
}))

import { countTestRecords, deleteTestRecords } from '@/lib/mcp/tools/testing'
import { supabaseAdmin } from '@/lib/supabase-admin'

const PROTECTED_ACCOUNT_ID = '30c2cd96-03e4-43cf-9536-81d961b18b1d' // Uxio Test LLC

interface Row {
  id: string
  account_id?: string | null
  is_test?: boolean
}

interface TableFixture {
  rows: Row[]
  deleteError?: { message: string }
}

function buildFromMock(tables: Record<string, TableFixture>) {
  return vi.fn((table: string) => {
    const fixture = tables[table] ?? { rows: [] }
    const chain: Record<string, unknown> = {}
    let mode: 'select' | 'delete' = 'select'
    let filtered = fixture.rows

    chain.select = vi.fn(() => chain)
    chain.delete = vi.fn(() => {
      mode = 'delete'
      return chain
    })
    chain.eq = vi.fn((col: string, val: unknown) => {
      filtered = filtered.filter((r) => (r as Record<string, unknown>)[col] === val)
      return chain
    })
    chain.in = vi.fn((col: string, vals: unknown[]) => {
      filtered = filtered.filter((r) => vals.includes((r as Record<string, unknown>)[col]))
      return chain
    })
    ;['order', 'limit'].forEach((m) => {
      chain[m] = vi.fn(() => chain)
    })
    chain.then = (resolve: (v: unknown) => unknown) => {
      if (mode === 'delete') {
        if (fixture.deleteError) {
          return Promise.resolve({ data: null, error: fixture.deleteError, count: null }).then(resolve)
        }
        return Promise.resolve({ data: filtered, error: null, count: filtered.length }).then(resolve)
      }
      return Promise.resolve({ data: fixture.rows, error: null, count: fixture.rows.length }).then(resolve)
    }
    return chain
  })
}

describe('test_cleanup — protected fixtures + honest error reporting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('countTestRecords excludes the protected account and anything billed to it', async () => {
    vi.mocked(supabaseAdmin.from).mockImplementation(
      buildFromMock({
        accounts: { rows: [{ id: PROTECTED_ACCOUNT_ID }, { id: 'acc-normal' }] },
        payments: {
          rows: [
            { id: 'pay-protected', account_id: PROTECTED_ACCOUNT_ID },
            { id: 'pay-normal', account_id: 'acc-normal' },
          ],
        },
        service_deliveries: { rows: [{ id: 'sd-protected', account_id: PROTECTED_ACCOUNT_ID }] },
        leads: { rows: [{ id: 'lead-1' }] },
        contacts: { rows: [{ id: 'contact-1' }] },
        account_contacts: { rows: [] },
      }),
    )

    const counts = await countTestRecords()

    expect(counts.accounts).toBe(1) // protected account excluded
    expect(counts.payments).toBe(1) // protected account's payment excluded
    expect(counts.service_deliveries).toBe(0) // its only SD belongs to the protected account
    expect(counts.leads).toBe(1)
    expect(counts.contacts).toBe(1)
  })

  it('deleteTestRecords never targets the protected account id in any delete call', async () => {
    const fromMock = buildFromMock({
      accounts: { rows: [{ id: PROTECTED_ACCOUNT_ID }, { id: 'acc-normal' }] },
      payments: { rows: [{ id: 'pay-normal', account_id: 'acc-normal' }] },
      service_deliveries: { rows: [] },
      contacts: { rows: [] },
      leads: { rows: [] },
      account_contacts: { rows: [] },
      tasks: { rows: [] },
      tax_returns: { rows: [] },
      client_expenses: { rows: [] },
      portal_messages: { rows: [] },
    })
    vi.mocked(supabaseAdmin.from).mockImplementation(fromMock)

    const { counts, errors } = await deleteTestRecords()

    expect(errors).toEqual([])
    expect(counts.accounts).toBe(1) // only acc-normal deleted

    // Assert the protected id was never passed to any .in('account_id'|'id', [...]) call
    const accountsChainCalls = fromMock.mock.results
      .filter((_, i) => fromMock.mock.calls[i][0] === 'accounts')
      .flatMap((r) => (r.value.in as ReturnType<typeof vi.fn>).mock.calls)
    for (const [, ids] of accountsChainCalls) {
      expect(ids).not.toContain(PROTECTED_ACCOUNT_ID)
    }
  })

  it('reports a real delete error instead of silently coercing it to 0 — the "Removed 0 records" bug', async () => {
    vi.mocked(supabaseAdmin.from).mockImplementation(
      buildFromMock({
        accounts: { rows: [] },
        payments: { rows: [{ id: 'pay-1', account_id: null, is_test: true }], deleteError: { message: 'update or delete on table "payments" violates foreign key constraint "client_expenses_td_payment_id_fkey"' } },
        service_deliveries: { rows: [] },
        contacts: { rows: [{ id: 'contact-1', is_test: true }] },
        leads: { rows: [{ id: 'lead-1', is_test: true }] },
        account_contacts: { rows: [] },
        tasks: { rows: [] },
        tax_returns: { rows: [] },
        client_expenses: { rows: [] },
        portal_messages: { rows: [] },
      }),
    )

    const { counts, errors } = await deleteTestRecords()

    expect(errors.length).toBe(1)
    expect(errors[0]).toContain('payments')
    expect(errors[0]).toContain('client_expenses_td_payment_id_fkey')
    // A table that failed must NOT appear as a fake zero success
    expect(counts.payments).toBeUndefined()
    // Unrelated tables still report their real counts
    expect(counts.contacts).toBe(1)
    expect(counts.leads).toBe(1)
  })
})
