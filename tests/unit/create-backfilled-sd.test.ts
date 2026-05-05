/**
 * Unit test for createBackfilledSD.
 *
 * Originally Step 14 of the billing-audit Service-from-payment workflow.
 * Extended 2026-05-05 (Bank-feed Tier B redesign) to cover:
 *   - account-or-contact XOR validation
 *   - contact-target propagates is_test from contacts table
 *   - service_type strict validation against VALID_SERVICE_TYPES
 *   - status='completed' (lowercase) per chk_sd_status DB constraint
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const insertCalls: Array<Record<string, unknown>> = []
const accountLookupCalls: string[] = []
const contactLookupCalls: string[] = []
let nextInsertResult: { data: { id: string; service_type: string; service_name: string } | null; error: { message: string } | null } = {
  data: { id: 'sd-1', service_type: 'Tax Return', service_name: 'Tax Return' },
  error: null,
}
let nextAccountIsTest: boolean = false
let nextContactIsTest: boolean = false

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'accounts') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: (_col: string, value: string) => {
            accountLookupCalls.push(value)
            return {
              maybeSingle: () => Promise.resolve({ data: { is_test: nextAccountIsTest }, error: null }),
            }
          },
        }
      }
      if (table === 'contacts') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: (_col: string, value: string) => {
            contactLookupCalls.push(value)
            return {
              maybeSingle: () => Promise.resolve({ data: { is_test: nextContactIsTest }, error: null }),
            }
          },
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
    const result = await q
    if (result.error) throw new Error(result.error.message)
    return result.data
  },
}))

import {
  createBackfilledSD,
  isValidServiceType,
  VALID_SERVICE_TYPES,
} from '@/lib/operations/service-delivery'

beforeEach(() => {
  insertCalls.length = 0
  accountLookupCalls.length = 0
  contactLookupCalls.length = 0
  nextAccountIsTest = false
  nextContactIsTest = false
  nextInsertResult = {
    data: { id: 'sd-1', service_type: 'Tax Return', service_name: 'Tax Return' },
    error: null,
  }
})

describe('createBackfilledSD — account target', () => {
  it('inserts with status=completed (lowercase), stage=Delivered, dates from delivered_on', async () => {
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
    expect(row.contact_id).toBe(null)
    expect(row.service_type).toBe('Tax Return')
    expect(row.service_name).toBe('Tax Return') // defaulted
    // chk_sd_status only allows lowercase {active,blocked,completed,cancelled,on_hold}
    expect(row.status).toBe('completed')
    expect(row.stage).toBe('Delivered')
    expect(row.start_date).toBe('2026-04-23')
    expect(row.end_date).toBe('2026-04-23')
    expect(row.amount).toBe(1500)
    expect(row.amount_currency).toBe('USD')
    expect(row.notes).toBe('audit backfill')
    expect(row.is_test).toBe(false)
    // Verifies the helper queried accounts (not contacts) for is_test
    expect(accountLookupCalls).toEqual(['acct-1'])
    expect(contactLookupCalls).toEqual([])
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

describe('createBackfilledSD — contact target (Tier B)', () => {
  it('inserts with contact_id only and account_id null', async () => {
    nextInsertResult = {
      data: { id: 'sd-c1', service_type: 'Company Formation', service_name: 'Aurora LLC formation' },
      error: null,
    }
    await createBackfilledSD({
      contact_id: 'cont-1',
      service_type: 'Company Formation',
      service_name: 'Aurora LLC formation',
      amount: 2500,
      amount_currency: 'EUR',
      delivered_on: '2026-04-30',
    })
    const row = insertCalls[0]
    expect(row.account_id).toBe(null)
    expect(row.contact_id).toBe('cont-1')
    expect(row.service_type).toBe('Company Formation')
    expect(row.service_name).toBe('Aurora LLC formation')
    expect(row.status).toBe('completed')
    expect(row.is_test).toBe(false)
    // Helper looks up is_test from contacts when account is absent
    expect(accountLookupCalls).toEqual([])
    expect(contactLookupCalls).toEqual(['cont-1'])
  })

  it('propagates is_test=true from the contact when account is null', async () => {
    nextContactIsTest = true
    await createBackfilledSD({
      contact_id: 'cont-1',
      service_type: 'Tax Return',
      amount: 100,
      amount_currency: 'USD',
      delivered_on: '2026-04-23',
    })
    expect(insertCalls[0].is_test).toBe(true)
  })
})

describe('createBackfilledSD — XOR validation', () => {
  it('rejects when both account_id and contact_id are set', async () => {
    await expect(
      createBackfilledSD({
        account_id: 'acct-1',
        contact_id: 'cont-1',
        service_type: 'Tax Return',
        amount: 1,
        amount_currency: 'USD',
        delivered_on: '2026-04-23',
      }),
    ).rejects.toThrow(/account_id OR contact_id, not both/)
    expect(insertCalls).toHaveLength(0)
  })

  it('rejects when neither account_id nor contact_id is set', async () => {
    await expect(
      createBackfilledSD({
        service_type: 'Tax Return',
        amount: 1,
        amount_currency: 'USD',
        delivered_on: '2026-04-23',
      }),
    ).rejects.toThrow(/account_id or contact_id required/)
    expect(insertCalls).toHaveLength(0)
  })

  it('rejects empty-string ids as if they were unset', async () => {
    await expect(
      createBackfilledSD({
        account_id: '',
        contact_id: '',
        service_type: 'Tax Return',
        amount: 1,
        amount_currency: 'USD',
        delivered_on: '2026-04-23',
      }),
    ).rejects.toThrow(/account_id or contact_id required/)
  })
})

describe('createBackfilledSD — service_type strict validation', () => {
  it('rejects free-text service_type that would trip the DB constraint', async () => {
    // The original 2026-05-04 bug: Antonio typed "2025 Tax Return" and got a
    // raw chk_sd_service_type 23514. Server-side validation now rejects it
    // with a readable error before reaching the DB.
    await expect(
      createBackfilledSD({
        account_id: 'acct-1',
        service_type: '2025 Tax Return',
        amount: 1,
        amount_currency: 'USD',
        delivered_on: '2026-04-23',
      }),
    ).rejects.toThrow(/invalid service_type "2025 Tax Return"/)
    expect(insertCalls).toHaveLength(0)
  })

  it('rejects empty service_type', async () => {
    await expect(
      createBackfilledSD({
        account_id: 'acct-1',
        service_type: '',
        amount: 1,
        amount_currency: 'USD',
        delivered_on: '2026-04-23',
      }),
    ).rejects.toThrow(/invalid service_type/)
  })

  it('accepts every value in VALID_SERVICE_TYPES', () => {
    for (const t of VALID_SERVICE_TYPES) {
      expect(isValidServiceType(t)).toBe(true)
    }
  })

  it('VALID_SERVICE_TYPES has exactly 18 values matching the DB constraint', () => {
    expect(VALID_SERVICE_TYPES).toHaveLength(18)
    // Spot-check: must include at least these canonical members
    expect(VALID_SERVICE_TYPES).toContain('Tax Return')
    expect(VALID_SERVICE_TYPES).toContain('Company Formation')
    expect(VALID_SERVICE_TYPES).toContain('CMRA Mailing Address')
    expect(VALID_SERVICE_TYPES).toContain('State Annual Report')
    expect(VALID_SERVICE_TYPES).toContain('Banking Physical')
    expect(VALID_SERVICE_TYPES).toContain('Public Notary')
    expect(VALID_SERVICE_TYPES).toContain('Shipping')
    expect(VALID_SERVICE_TYPES).toContain('Support')
    expect(VALID_SERVICE_TYPES).toContain('EIN Application')
    expect(VALID_SERVICE_TYPES).toContain('Client Offboarding')
  })
})
