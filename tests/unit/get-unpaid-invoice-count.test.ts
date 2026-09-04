/**
 * Unit test for getUnpaidInvoiceCount (lib/portal/queries.ts) — drives the
 * sidebar TD Billing tab's pulse + count badge, same mechanism as the
 * existing Documents/Sign Documents badges. Routed through countOrFailOpen
 * (council review, 2026-09-04) so a database error shows the alert rather
 * than silently hiding a real unpaid invoice. R086: every new function in
 * lib/ gets a unit test.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

type FilterCall = { method: 'eq' | 'in'; column: string; value: unknown }

let captured: FilterCall[] = []
let lastTable = ''
let mockCount: number | null = 0
let mockError: { message: string } | null = null

function makeChain(table: string) {
  lastTable = table
  const settle = () => Promise.resolve({ count: mockCount, error: mockError })
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn(function (this: unknown, column: string, value: unknown) {
      captured.push({ method: 'eq', column, value })
      return chain
    }),
    in: vi.fn(function (this: unknown, column: string, value: unknown) {
      captured.push({ method: 'in', column, value })
      return chain
    }),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      settle().then(resolve, reject),
  }
  return chain
}

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => makeChain(table),
  },
}))

import { getUnpaidInvoiceCount } from '@/lib/portal/queries'

beforeEach(() => {
  captured = []
  lastTable = ''
  mockCount = 0
  mockError = null
})

describe('getUnpaidInvoiceCount', () => {
  it('returns 0 without querying when accountId is empty', async () => {
    const result = await getUnpaidInvoiceCount('')
    expect(result).toBe(0)
    expect(lastTable).toBe('')
  })

  it('queries payments filtered by account_id and Sent/Overdue/Partial invoice_status', async () => {
    mockCount = 2
    const result = await getUnpaidInvoiceCount('acct-1')

    expect(lastTable).toBe('payments')
    expect(captured).toEqual(
      expect.arrayContaining([
        { method: 'eq', column: 'account_id', value: 'acct-1' },
        { method: 'in', column: 'invoice_status', value: ['Sent', 'Overdue', 'Partial'] },
      ]),
    )
    expect(result).toBe(2)
  })

  it('includes Partial so a partially-paid invoice still counts as unpaid', async () => {
    mockCount = 1
    await getUnpaidInvoiceCount('acct-1')
    const inCall = captured.find(c => c.method === 'in' && c.column === 'invoice_status')
    expect(inCall?.value).toContain('Partial')
  })

  it('returns 0 when no rows match', async () => {
    mockCount = null
    const result = await getUnpaidInvoiceCount('acct-empty')
    expect(result).toBe(0)
  })

  it('fails OPEN on a database error — shows the alert rather than hiding a real unpaid invoice', async () => {
    mockCount = null
    mockError = { message: 'statement timeout' }
    const result = await getUnpaidInvoiceCount('acct-1')
    expect(result).toBe(1)
  })
})
