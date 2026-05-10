import { describe, it, expect } from 'vitest'
import { tierForContract } from '@/lib/portal/auto-create'
import { PORTAL_TIERS } from '@/lib/portal/tier-config'

describe('tierForContract', () => {
  // Direct tier matches — contract type IS the tier name
  it('formation → formation', () => {
    expect(tierForContract('formation')).toBe('formation')
  })

  it('onboarding → onboarding', () => {
    expect(tierForContract('onboarding')).toBe('onboarding')
  })

  // Everything else maps to 'active'
  it('tax_return → active', () => {
    expect(tierForContract('tax_return')).toBe('active')
  })

  it('itin → active', () => {
    expect(tierForContract('itin')).toBe('active')
  })

  it('closure → active', () => {
    expect(tierForContract('closure')).toBe('active')
  })

  it('renewal → active (renewal clients are already active)', () => {
    expect(tierForContract('renewal')).toBe('active')
  })

  // Edge cases — null/undefined/empty/unknown all default to active.
  // These should not occur in practice (activate-service falls back to
  // 'formation' upstream when contract_type is missing) but the helper
  // must be total: every input must yield a valid PortalTier.
  it('unknown string → active', () => {
    expect(tierForContract('made_up_type')).toBe('active')
  })

  it('empty string → active', () => {
    expect(tierForContract('')).toBe('active')
  })

  it('null → active', () => {
    expect(tierForContract(null)).toBe('active')
  })

  it('undefined → active', () => {
    expect(tierForContract(undefined)).toBe('active')
  })

  // Case sensitivity — only exact lowercase matches are special-cased.
  // Contract types in this codebase are always lowercase enums, so an
  // uppercase input is treated as unknown (→ active). This is intentional:
  // mismatched casing should not silently land on the wrong tier.
  it('Formation (capitalized) → active', () => {
    expect(tierForContract('Formation')).toBe('active')
  })

  it('FORMATION → active', () => {
    expect(tierForContract('FORMATION')).toBe('active')
  })

  // Output guarantee — every result is one of the four R102 portal tiers
  // and never 'lead' (which is reserved for unpaid offer state).
  it('only ever returns formation, onboarding, or active (never lead)', () => {
    const inputs = ['formation', 'onboarding', 'tax_return', 'itin', 'closure', 'renewal', '', 'xyz', null, undefined]
    for (const input of inputs) {
      const result = tierForContract(input)
      expect(PORTAL_TIERS).toContain(result)
      expect(result).not.toBe('lead')
    }
  })
})
