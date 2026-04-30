import { describe, it, expect } from 'vitest'
import { isFieldEligibleForNA } from '@/lib/audit/na-allow-list'

// ── Service fixtures ───────────────────────────────────────────────────────

const NO_SERVICES: string[] = []
const FORMATION_SERVICES = ['Company Formation']
const ITIN_SERVICES = ['ITIN']
const BANKING_SERVICES = ['Banking Fintech']
const TAX_SERVICES = ['Tax Return']
const CMRA_SERVICES = ['CMRA Mailing Address']
const ONBOARDING_SERVICES = ['Client Onboarding']
const ALL_SERVICES = ['Company Formation', 'ITIN', 'Banking Fintech', 'Tax Return', 'CMRA Mailing Address']

// ── Contact — never eligible ───────────────────────────────────────────────

describe('isFieldEligibleForNA — contact critical fields (never N/A)', () => {
  it('email is never eligible regardless of services', () => {
    expect(isFieldEligibleForNA('email', 'contact', NO_SERVICES)).toBe(false)
    expect(isFieldEligibleForNA('email', 'contact', ALL_SERVICES)).toBe(false)
  })

  it('full_name is never eligible regardless of services', () => {
    expect(isFieldEligibleForNA('full_name', 'contact', NO_SERVICES)).toBe(false)
    expect(isFieldEligibleForNA('full_name', 'contact', ALL_SERVICES)).toBe(false)
  })
})

// ── Contact — service-conditional fields ──────────────────────────────────

describe('isFieldEligibleForNA — citizenship (service-conditional)', () => {
  it('eligible when no triggering services active', () => {
    expect(isFieldEligibleForNA('citizenship', 'contact', NO_SERVICES)).toBe(true)
    expect(isFieldEligibleForNA('citizenship', 'contact', CMRA_SERVICES)).toBe(true)
  })

  it('NOT eligible when Company Formation is active', () => {
    expect(isFieldEligibleForNA('citizenship', 'contact', FORMATION_SERVICES)).toBe(false)
  })

  it('NOT eligible when ITIN is active', () => {
    expect(isFieldEligibleForNA('citizenship', 'contact', ITIN_SERVICES)).toBe(false)
  })

  it('NOT eligible when Banking Fintech is active', () => {
    expect(isFieldEligibleForNA('citizenship', 'contact', BANKING_SERVICES)).toBe(false)
  })

  it('NOT eligible when Tax Return is active', () => {
    expect(isFieldEligibleForNA('citizenship', 'contact', TAX_SERVICES)).toBe(false)
  })

  it('NOT eligible when Client Onboarding is active', () => {
    expect(isFieldEligibleForNA('citizenship', 'contact', ONBOARDING_SERVICES)).toBe(false)
  })
})

describe('isFieldEligibleForNA — date_of_birth (service-conditional)', () => {
  it('eligible when no triggering services active', () => {
    expect(isFieldEligibleForNA('date_of_birth', 'contact', NO_SERVICES)).toBe(true)
    expect(isFieldEligibleForNA('date_of_birth', 'contact', CMRA_SERVICES)).toBe(true)
  })

  it('NOT eligible when Formation is active', () => {
    expect(isFieldEligibleForNA('date_of_birth', 'contact', FORMATION_SERVICES)).toBe(false)
  })

  it('NOT eligible when ITIN is active', () => {
    expect(isFieldEligibleForNA('date_of_birth', 'contact', ITIN_SERVICES)).toBe(false)
  })
})

describe('isFieldEligibleForNA — address_line1 (service-conditional)', () => {
  it('eligible when no triggering services active', () => {
    expect(isFieldEligibleForNA('address_line1', 'contact', NO_SERVICES)).toBe(true)
    expect(isFieldEligibleForNA('address_line1', 'contact', ITIN_SERVICES)).toBe(true)
  })

  it('NOT eligible when Company Formation is active', () => {
    expect(isFieldEligibleForNA('address_line1', 'contact', FORMATION_SERVICES)).toBe(false)
  })

  it('NOT eligible when Banking Fintech is active', () => {
    expect(isFieldEligibleForNA('address_line1', 'contact', BANKING_SERVICES)).toBe(false)
  })

  it('NOT eligible when CMRA is active', () => {
    expect(isFieldEligibleForNA('address_line1', 'contact', CMRA_SERVICES)).toBe(false)
  })
})

describe('isFieldEligibleForNA — passport_on_file (service-conditional)', () => {
  it('eligible when no triggering services active', () => {
    expect(isFieldEligibleForNA('passport_on_file', 'contact', NO_SERVICES)).toBe(true)
    expect(isFieldEligibleForNA('passport_on_file', 'contact', FORMATION_SERVICES)).toBe(true)
    expect(isFieldEligibleForNA('passport_on_file', 'contact', CMRA_SERVICES)).toBe(true)
  })

  it('NOT eligible when ITIN is active', () => {
    expect(isFieldEligibleForNA('passport_on_file', 'contact', ITIN_SERVICES)).toBe(false)
  })

  it('NOT eligible when Banking Fintech is active', () => {
    expect(isFieldEligibleForNA('passport_on_file', 'contact', BANKING_SERVICES)).toBe(false)
  })
})

// ── Contact — warning-only fields (always eligible) ───────────────────────

describe('isFieldEligibleForNA — itin_number (always eligible)', () => {
  it('eligible regardless of services', () => {
    expect(isFieldEligibleForNA('itin_number', 'contact', NO_SERVICES)).toBe(true)
    expect(isFieldEligibleForNA('itin_number', 'contact', ALL_SERVICES)).toBe(true)
  })
})

// ── Contact — unknown fields ───────────────────────────────────────────────

describe('isFieldEligibleForNA — unknown contact field', () => {
  it('returns false for unknown field names', () => {
    expect(isFieldEligibleForNA('passport_number', 'contact', NO_SERVICES)).toBe(false)
    expect(isFieldEligibleForNA('phone', 'contact', NO_SERVICES)).toBe(false)
  })
})

// ── Account — never eligible ───────────────────────────────────────────────

describe('isFieldEligibleForNA — account critical fields (never N/A)', () => {
  it('entity_type is never eligible', () => {
    expect(isFieldEligibleForNA('entity_type', 'account', NO_SERVICES)).toBe(false)
    expect(isFieldEligibleForNA('entity_type', 'account', ALL_SERVICES)).toBe(false)
  })

  it('state_of_formation is never eligible', () => {
    expect(isFieldEligibleForNA('state_of_formation', 'account', NO_SERVICES)).toBe(false)
    expect(isFieldEligibleForNA('state_of_formation', 'account', ALL_SERVICES)).toBe(false)
  })
})

// ── Account — always eligible ──────────────────────────────────────────────

describe('isFieldEligibleForNA — account eligible fields', () => {
  it('ein_number is always eligible', () => {
    expect(isFieldEligibleForNA('ein_number', 'account', NO_SERVICES)).toBe(true)
    expect(isFieldEligibleForNA('ein_number', 'account', ALL_SERVICES)).toBe(true)
  })

  it('onboarding_date is always eligible', () => {
    expect(isFieldEligibleForNA('onboarding_date', 'account', NO_SERVICES)).toBe(true)
    expect(isFieldEligibleForNA('onboarding_date', 'account', ALL_SERVICES)).toBe(true)
  })

  it('physical_address is always eligible', () => {
    expect(isFieldEligibleForNA('physical_address', 'account', NO_SERVICES)).toBe(true)
    expect(isFieldEligibleForNA('physical_address', 'account', CMRA_SERVICES)).toBe(true)
    expect(isFieldEligibleForNA('physical_address', 'account', ALL_SERVICES)).toBe(true)
  })
})

// ── Account — unknown fields ───────────────────────────────────────────────

describe('isFieldEligibleForNA — unknown account field', () => {
  it('returns false for unknown field names', () => {
    expect(isFieldEligibleForNA('company_name', 'account', NO_SERVICES)).toBe(false)
    expect(isFieldEligibleForNA('notes', 'account', NO_SERVICES)).toBe(false)
  })
})

// ── Service entity — Phase 4 not implemented ──────────────────────────────

describe('isFieldEligibleForNA — service entity (Phase 4, not implemented)', () => {
  it('returns false for service entity type regardless of field', () => {
    expect(isFieldEligibleForNA('status', 'service', NO_SERVICES)).toBe(false)
    expect(isFieldEligibleForNA('ein_number', 'service', NO_SERVICES)).toBe(false)
  })
})
