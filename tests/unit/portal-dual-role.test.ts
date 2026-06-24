/**
 * Unit tests for dual-role portal helpers (R086).
 * parsePortalRoles: pure function in lib/portal/queries.ts
 * hasPartnerRole / hasClientRole: pure functions in lib/portal/tier-config.ts
 */

import { describe, it, expect, vi } from 'vitest'

// Mock supabaseAdmin so queries.ts can be imported without a real DB
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {},
}))

vi.mock('@/lib/addresses', () => ({
  resolveMailingAddress: vi.fn(),
}))

import { parsePortalRoles } from '@/lib/portal/queries'
import { hasPartnerRole, hasClientRole, isPartnerPortal } from '@/lib/portal/tier-config'

describe('parsePortalRoles', () => {
  it('returns isClient+isPartner for client+partner', () => {
    expect(parsePortalRoles('client+partner')).toEqual({ isClient: true, isPartner: true })
  })
  it('returns isPartner only for partner', () => {
    expect(parsePortalRoles('partner')).toEqual({ isClient: false, isPartner: true })
  })
  it('returns isClient only for client', () => {
    expect(parsePortalRoles('client')).toEqual({ isClient: true, isPartner: false })
  })
  it('defaults to isClient for null', () => {
    expect(parsePortalRoles(null)).toEqual({ isClient: true, isPartner: false })
  })
})

describe('hasPartnerRole', () => {
  it('true for partner', () => expect(hasPartnerRole('partner')).toBe(true))
  it('true for client+partner', () => expect(hasPartnerRole('client+partner')).toBe(true))
  it('false for client', () => expect(hasPartnerRole('client')).toBe(false))
  it('false for null', () => expect(hasPartnerRole(null)).toBe(false))
  it('false for undefined', () => expect(hasPartnerRole(undefined)).toBe(false))
})

describe('hasClientRole', () => {
  it('true for client', () => expect(hasClientRole('client')).toBe(true))
  it('true for client+partner', () => expect(hasClientRole('client+partner')).toBe(true))
  it('true for null (default)', () => expect(hasClientRole(null)).toBe(true))
  it('true for undefined (default)', () => expect(hasClientRole(undefined)).toBe(true))
  it('false for partner', () => expect(hasClientRole('partner')).toBe(false))
})

describe('isPartnerPortal (regression — must NOT change for dual-role)', () => {
  it('false for client+partner (dual-role stays in client portal by default)', () => {
    expect(isPartnerPortal('client+partner')).toBe(false)
  })
  it('true for pure partner', () => expect(isPartnerPortal('partner')).toBe(true))
})
