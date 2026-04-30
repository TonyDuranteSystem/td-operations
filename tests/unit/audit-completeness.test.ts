import { describe, it, expect } from 'vitest'
import {
  scoreContact,
  scoreAccount,
  computeCompleteness,
  type ContactInput,
  type AccountInput,
} from '@/lib/audit/completeness-rules'

// ── Fixtures ───────────────────────────────────────────────────────────────

const FULL_CONTACT: ContactInput = {
  full_name: 'Mario Rossi',
  email: 'mario@example.com',
  itin_number: '987-65-4321',
  citizenship: 'IT',
  date_of_birth: '1980-05-01',
  passport_on_file: true,
  address_line1: '123 Main St',
}

const MINIMAL_CONTACT: ContactInput = {
  full_name: 'Jane Doe',
  email: 'jane@example.com',
  itin_number: null,
  citizenship: null,
  date_of_birth: null,
  passport_on_file: null,
  address_line1: null,
}

const FULL_ACCOUNT: AccountInput = {
  entity_type: 'LLC - Single Member',
  ein_number: '12-3456789',
  state_of_formation: 'WY',
  physical_address: '123 Main St',
  onboarding_date: '2024-01-15',
  account_type: 'Client',
}

const NO_SERVICES: string[] = []

const FORMATION_SERVICES = ['Company Formation']
const ITIN_SERVICES = ['ITIN']
const BANKING_SERVICES = ['Banking Fintech']
const CMRA_SERVICES = ['CMRA Mailing Address']
const MULTI_SERVICES = ['Company Formation', 'Tax Return', 'CMRA Mailing Address']

// ── scoreContact ───────────────────────────────────────────────────────────

describe('scoreContact', () => {
  it('returns red with "No linked contact" when contact is null', () => {
    const r = scoreContact(null, NO_SERVICES)
    expect(r.status).toBe('red')
    expect(r.missing_critical).toContain('No linked contact')
  })

  it('returns green for full contact with no services (ITIN is warning only)', () => {
    const r = scoreContact(FULL_CONTACT, NO_SERVICES)
    expect(r.status).toBe('green')
    expect(r.missing_critical).toHaveLength(0)
    expect(r.missing_warning).toHaveLength(0)
  })

  it('returns yellow when ITIN is missing but everything else present (no services)', () => {
    const r = scoreContact(MINIMAL_CONTACT, NO_SERVICES)
    // email + full_name present → no critical from always-required
    // no services → no conditional criticals
    // itin_number missing → warning
    expect(r.status).toBe('yellow')
    expect(r.missing_warning).toContain('ITIN')
    expect(r.missing_critical).toHaveLength(0)
  })

  it('returns red when email is missing', () => {
    const r = scoreContact({ ...FULL_CONTACT, email: null }, NO_SERVICES)
    expect(r.status).toBe('red')
    expect(r.missing_critical).toContain('Email')
  })

  it('returns red when full_name is empty string', () => {
    const r = scoreContact({ ...FULL_CONTACT, full_name: '   ' }, NO_SERVICES)
    expect(r.status).toBe('red')
    expect(r.missing_critical).toContain('Full name')
  })

  it('requires citizenship + DOB when Company Formation is active', () => {
    const r = scoreContact(MINIMAL_CONTACT, FORMATION_SERVICES)
    expect(r.missing_critical).toContain('Citizenship')
    expect(r.missing_critical).toContain('Date of birth')
  })

  it('requires address when Company Formation is active', () => {
    const r = scoreContact(MINIMAL_CONTACT, FORMATION_SERVICES)
    expect(r.missing_critical).toContain('Address')
  })

  it('requires passport_on_file when ITIN service is active', () => {
    const r = scoreContact(MINIMAL_CONTACT, ITIN_SERVICES)
    expect(r.missing_critical).toContain('Passport on file')
  })

  it('requires passport_on_file when Banking Fintech is active', () => {
    const r = scoreContact(MINIMAL_CONTACT, BANKING_SERVICES)
    expect(r.missing_critical).toContain('Passport on file')
  })

  it('requires address when CMRA Mailing Address is active', () => {
    // CMRA is in ADDRESS_SERVICES — contact must have an address on file
    const r = scoreContact(MINIMAL_CONTACT, CMRA_SERVICES)
    expect(r.missing_critical).toContain('Address')
  })

  it('green for full contact with all services active', () => {
    const r = scoreContact(FULL_CONTACT, MULTI_SERVICES)
    expect(r.status).toBe('green')
    expect(r.missing_critical).toHaveLength(0)
  })

  it('does not require conditional fields when no matching service is active', () => {
    // Only CMRA active — no citizenship/DOB/address/passport triggers
    const r = scoreContact(MINIMAL_CONTACT, CMRA_SERVICES)
    expect(r.missing_critical).not.toContain('Citizenship')
    expect(r.missing_critical).not.toContain('Date of birth')
    expect(r.missing_critical).not.toContain('Passport on file')
  })
})

// ── scoreAccount ───────────────────────────────────────────────────────────

describe('scoreAccount', () => {
  it('returns green for a complete standard account', () => {
    const r = scoreAccount(FULL_ACCOUNT, NO_SERVICES)
    expect(r.status).toBe('green')
    expect(r.missing_critical).toHaveLength(0)
  })

  it('returns green for Partner account (not scored)', () => {
    const r = scoreAccount({ ...FULL_ACCOUNT, account_type: 'Partner' }, MULTI_SERVICES)
    expect(r.status).toBe('green')
    expect(r.missing_critical).toHaveLength(0)
    expect(r.missing_warning).toHaveLength(0)
  })

  it('requires entity_type as critical', () => {
    const r = scoreAccount({ ...FULL_ACCOUNT, entity_type: null }, NO_SERVICES)
    expect(r.missing_critical).toContain('Entity type')
  })

  it('requires state_of_formation as critical', () => {
    const r = scoreAccount({ ...FULL_ACCOUNT, state_of_formation: null }, NO_SERVICES)
    expect(r.missing_critical).toContain('State of formation')
  })

  it('requires EIN as critical for standard client', () => {
    const r = scoreAccount({ ...FULL_ACCOUNT, ein_number: null }, NO_SERVICES)
    expect(r.missing_critical).toContain('EIN')
  })

  it('requires start date as critical for standard client', () => {
    const r = scoreAccount({ ...FULL_ACCOUNT, onboarding_date: null }, NO_SERVICES)
    expect(r.missing_critical).toContain('Start date')
  })

  it('EIN is warning (not critical) for One-Time account', () => {
    const r = scoreAccount(
      { ...FULL_ACCOUNT, ein_number: null, account_type: 'One-Time' },
      NO_SERVICES,
    )
    expect(r.missing_critical).not.toContain('EIN')
    expect(r.missing_warning).toContain('EIN')
  })

  it('start date is warning (not critical) for One-Time account', () => {
    const r = scoreAccount(
      { ...FULL_ACCOUNT, onboarding_date: null, account_type: 'One-Time' },
      NO_SERVICES,
    )
    expect(r.missing_critical).not.toContain('Start date')
    expect(r.missing_warning).toContain('Start date')
  })

  it('adds CMRA warning when physical_address missing and CMRA active', () => {
    const r = scoreAccount(
      { ...FULL_ACCOUNT, physical_address: null },
      CMRA_SERVICES,
    )
    expect(r.missing_warning).toContain('Physical address (CMRA active)')
  })

  it('no CMRA warning when physical_address present', () => {
    const r = scoreAccount(FULL_ACCOUNT, CMRA_SERVICES)
    expect(r.missing_warning).not.toContain('Physical address (CMRA active)')
  })

  it('returns red when multiple criticals missing', () => {
    const r = scoreAccount(
      { ...FULL_ACCOUNT, entity_type: null, ein_number: null, state_of_formation: null },
      NO_SERVICES,
    )
    expect(r.status).toBe('red')
    expect(r.missing_critical.length).toBeGreaterThanOrEqual(3)
  })

  it('returns yellow when only warnings present', () => {
    const r = scoreAccount(
      { ...FULL_ACCOUNT, physical_address: null },
      CMRA_SERVICES,
    )
    expect(r.status).toBe('yellow')
  })
})

// ── computeCompleteness ────────────────────────────────────────────────────

describe('computeCompleteness', () => {
  it('returns both contact and account scores', () => {
    const r = computeCompleteness(FULL_ACCOUNT, FULL_CONTACT, NO_SERVICES)
    expect(r).toHaveProperty('contact')
    expect(r).toHaveProperty('account')
  })

  it('contact red + account green when contact missing', () => {
    const r = computeCompleteness(FULL_ACCOUNT, null, NO_SERVICES)
    expect(r.contact.status).toBe('red')
    expect(r.account.status).toBe('green')
  })

  it('contact green + account red when account incomplete', () => {
    const r = computeCompleteness(
      { ...FULL_ACCOUNT, ein_number: null, entity_type: null },
      FULL_CONTACT,
      NO_SERVICES,
    )
    expect(r.contact.status).toBe('green')
    expect(r.account.status).toBe('red')
  })
})
