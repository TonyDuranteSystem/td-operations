import { describe, it, expect, vi } from 'vitest'
import { isValidKind, linkedAccountCount, nearDupeCheck } from '@/lib/addresses'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

/* eslint-disable no-restricted-syntax */

// ── isValidKind ─────────────────────────────────────────────────────────────

describe('isValidKind', () => {
  it('accepts valid kinds', () => {
    expect(isValidKind('business_legal')).toBe(true)
    expect(isValidKind('business_mailing')).toBe(true)
    expect(isValidKind('registered_agent')).toBe(true)
  })

  it('rejects invalid kinds', () => {
    expect(isValidKind('mailing')).toBe(false)
    expect(isValidKind('ra')).toBe(false)
    expect(isValidKind('')).toBe(false)
    expect(isValidKind(null)).toBe(false)
    expect(isValidKind(undefined)).toBe(false)
    expect(isValidKind(42)).toBe(false)
  })
})

// ── helpers for building mock Supabase chains ────────────────────────────────

function mockChain(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    ...overrides,
  }
  // Make every method return `chain` by default
  Object.keys(chain).forEach((k) => {
    if (typeof chain[k] === 'function' && !(chain[k] as ReturnType<typeof vi.fn>).mock) {
      chain[k] = vi.fn().mockReturnValue(chain)
    }
  })
  return chain
}

function mockDb(fromResult: Record<string, unknown>): SupabaseClient<Database> {
  return { from: vi.fn().mockReturnValue(fromResult) } as unknown as SupabaseClient<Database>
}

// ── linkedAccountCount ───────────────────────────────────────────────────────

describe('linkedAccountCount', () => {
  it('returns the count from the DB', async () => {
    const chain = mockChain()
    // Final awaited value
    chain.not = vi.fn().mockResolvedValue({ count: 12, error: null })
    const db = mockDb(chain)

    const result = await linkedAccountCount(db, 'addr-uuid-1')
    expect(result).toBe(12)
  })

  it('returns 0 when count is null', async () => {
    const chain = mockChain()
    chain.not = vi.fn().mockResolvedValue({ count: null, error: null })
    const db = mockDb(chain)

    const result = await linkedAccountCount(db, 'addr-uuid-2')
    expect(result).toBe(0)
  })

  it('throws when the DB returns an error', async () => {
    const chain = mockChain()
    chain.not = vi.fn().mockResolvedValue({ count: null, error: { message: 'DB failure' } })
    const db = mockDb(chain)

    await expect(linkedAccountCount(db, 'addr-uuid-3')).rejects.toThrow('DB failure')
  })
})

// ── nearDupeCheck ────────────────────────────────────────────────────────────

describe('nearDupeCheck', () => {
  it('returns the matching row when a near-dupe exists', async () => {
    const match = { id: 'existing-id', name: 'Harbor Compliance — Sheridan, WY' }
    const chain = mockChain()
    chain.limit = vi.fn().mockResolvedValue({ data: [match], error: null })
    const db = mockDb(chain)

    const result = await nearDupeCheck(db, 'registered_agent', '1401 Sheridan Ave', 'Sheridan', 'WY')
    expect(result).toEqual(match)
  })

  it('returns null when no near-dupe exists', async () => {
    const chain = mockChain()
    chain.limit = vi.fn().mockResolvedValue({ data: [], error: null })
    const db = mockDb(chain)

    const result = await nearDupeCheck(db, 'business_legal', '123 Main St', 'Albuquerque', 'NM')
    expect(result).toBeNull()
  })

  it('returns null when data is null', async () => {
    const chain = mockChain()
    chain.limit = vi.fn().mockResolvedValue({ data: null, error: null })
    const db = mockDb(chain)

    const result = await nearDupeCheck(db, 'business_mailing', '456 Oak Ave', 'Tampa', 'FL')
    expect(result).toBeNull()
  })

  it('applies excludeId when provided', async () => {
    const chain = mockChain()
    const neqSpy = vi.fn().mockResolvedValue({ data: [], error: null })
    chain.limit = vi.fn().mockReturnValue({ neq: neqSpy })
    const db = mockDb(chain)

    await nearDupeCheck(db, 'registered_agent', '1401 Sheridan Ave', 'Sheridan', 'WY', 'exclude-this-id')
    expect(neqSpy).toHaveBeenCalledWith('id', 'exclude-this-id')
  })

  it('throws when the DB returns an error', async () => {
    const chain = mockChain()
    chain.limit = vi.fn().mockResolvedValue({ data: null, error: { message: 'query failed' } })
    const db = mockDb(chain)

    await expect(
      nearDupeCheck(db, 'business_legal', '1 Test St', 'Miami', 'FL')
    ).rejects.toThrow('query failed')
  })
})

/* eslint-enable no-restricted-syntax */
