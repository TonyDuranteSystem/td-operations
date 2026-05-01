import { describe, it, expect, vi } from 'vitest'
import { isValidKind, linkedAccountCount, nearDupeCheck, formatAddressString, resolveMailingAddress } from '@/lib/addresses'
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

// ── formatAddressString ──────────────────────────────────────────────────────

describe('formatAddressString', () => {
  it('returns null for null input', () => {
    expect(formatAddressString(null)).toBeNull()
    expect(formatAddressString(undefined)).toBeNull()
  })

  it('returns null when address_line1 is missing', () => {
    expect(formatAddressString({ address_line1: null, city: 'Miami', state: 'FL', zip: '33101' })).toBeNull()
  })

  it('formats a standard address without line2', () => {
    expect(formatAddressString({
      address_line1: '10225 Ulmerton Rd',
      city: 'Largo',
      state: 'FL',
      zip: '33771',
    })).toBe('10225 Ulmerton Rd, Largo FL 33771')
  })

  it('includes address_line2 when present', () => {
    expect(formatAddressString({
      address_line1: '10225 Ulmerton Rd',
      address_line2: 'Suite 3D',
      city: 'Largo',
      state: 'FL',
      zip: '33771',
    })).toBe('10225 Ulmerton Rd, Suite 3D, Largo FL 33771')
  })

  it('handles missing city/state/zip gracefully', () => {
    expect(formatAddressString({ address_line1: '123 Main St', city: null, state: null, zip: null })).toBe('123 Main St')
  })
})

// ── resolveMailingAddress ────────────────────────────────────────────────────

describe('resolveMailingAddress', () => {
  it('returns formatted address from mailingRow when present', () => {
    expect(resolveMailingAddress(
      { address_line1: '10225 Ulmerton Rd', city: 'Largo', state: 'FL', zip: '33771' },
      '456 Old St, Miami, FL 33101',
    )).toBe('10225 Ulmerton Rd, Largo FL 33771')
  })

  it('falls back to legacyPhysical when mailingRow is null', () => {
    expect(resolveMailingAddress(null, '456 Old St, Miami, FL 33101')).toBe('456 Old St, Miami, FL 33101')
  })

  it('falls back to legacyPhysical when mailingRow is undefined', () => {
    expect(resolveMailingAddress(undefined, '456 Old St')).toBe('456 Old St')
  })

  it('falls back to legacyPhysical when mailingRow has no address_line1', () => {
    expect(resolveMailingAddress(
      { address_line1: null, city: 'Largo', state: 'FL', zip: '33771' },
      'legacy fallback',
    )).toBe('legacy fallback')
  })

  it('returns null when both are absent', () => {
    expect(resolveMailingAddress(null, null)).toBeNull()
    expect(resolveMailingAddress(undefined, undefined)).toBeNull()
  })
})
