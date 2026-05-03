/**
 * Unit test for createBackfilledSD (Step 14 — billing-audit
 * Service-from-payment workflow).
 *
 * Covers:
 *   - Required fields are written verbatim
 *   - service_name defaults to service_type when omitted
 *   - status='Completed', stage='Delivered' set unconditionally
 *   - is_test propagates from the parent account
 *   - Error from supabase surfaces as a thrown Error
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const insertCalls: Array<Record<string, unknown>> = []
let nextInsertResult: { data: { id: string; service_type: string; service_name: string } | null; error: { message: string } | null } = {
  data: { id: 'sd-1', service_type: 'Tax Return', service_name: 'Tax Return' },
  error: null,
}
let nextAccountIsTest: boolean = false

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'accounts') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: () => Promise.resolve({ data: { is_test: nextAccountIsTest }, error: null }),
        }
      }
      if (table === 'service_deliveries') {
        return {
          insert: (row: Record<string, unknown>) => {
            insertCalls.push(row)
            return {
              select: vi.fn().mockReturnThis(),
              single: () => Promise.resolve(nextInsertResult),
            }
          },
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
  },
}))

vi.mock('@/lib/db', () => ({
  // Pass-through wrapper used by lib/operations/service-delivery.ts
  dbWrite: async (q: { single?: () => Promise<{ data: unknown; error: { message: string } | null }> } & Promise<{ data: unknown; error: { message: string } | null }>) => {
    // The query builder is thenable / awaitable — but our mock above already
    // returns a Promise from .single(). Just await whatever was passed.
    const result = await q
    if (result.error) throw new Error(result.error.message)
    return result.data
  },
}))

import { createBackfilledSD } from '@/lib/operations/service-delivery'

beforeEach(() => {
  insertCalls.length = 0
  nextAccountIsTest = false
  nextInsertResult = {
    data: { id: 'sd-1', service_type: 'Tax Return', service_name: 'Tax Return' },
    error: null,
  }
})

describe('createBackfilledSD', () => {
  it('inserts with status=Completed, stage=Delivered, dates from delivered_on', async () => {
    await createBackfilledSD({
      account_id: 'acct-1',
      service_type: 'Tax Return',
      amount: 1500,
      amount_currency: 'USD',
      delivered_on: '2026-04-23',
      notes: 'audit backfill',
    })
    expect(insertCalls).toHaveLength(1)
    const row = insertCalls[0]
    expect(row.account_id).toBe('acct-1')
    expect(row.service_type).toBe('Tax Return')
    expect(row.service_name).toBe('Tax Return') // defaulted
    expect(row.status).toBe('Completed')
    expect(row.stage).toBe('Delivered')
    expect(row.start_date).toBe('2026-04-23')
    expect(row.end_date).toBe('2026-04-23')
    expect(row.amount).toBe(1500)
    expect(row.amount_currency).toBe('USD')
    expect(row.notes).toBe('audit backfill')
    expect(row.is_test).toBe(false)
  })

  it('uses provided service_name when given', async () => {
    nextInsertResult = {
      data: { id: 'sd-2', service_type: 'Shipping', service_name: 'Adriano shipping fee' },
      error: null,
    }
    await createBackfilledSD({
      account_id: 'acct-1',
      service_type: 'Shipping',
      service_name: 'Adriano shipping fee',
      amount: 63,
      amount_currency: 'USD',
      delivered_on: '2026-04-18',
    })
    expect(insertCalls[0].service_name).toBe('Adriano shipping fee')
  })

  it('propagates is_test=true from the parent account', async () => {
    nextAccountIsTest = true
    await createBackfilledSD({
      account_id: 'acct-1',
      service_type: 'Tax Return',
      amount: 100,
      amount_currency: 'USD',
      delivered_on: '2026-04-23',
    })
    expect(insertCalls[0].is_test).toBe(true)
  })

  it('throws when the insert fails', async () => {
    nextInsertResult = { data: null, error: { message: 'unique violation' } }
    await expect(
      createBackfilledSD({
        account_id: 'acct-1',
        service_type: 'Tax Return',
        amount: 1,
        amount_currency: 'USD',
        delivered_on: '2026-04-23',
      }),
    ).rejects.toThrow(/unique violation/)
  })
})
