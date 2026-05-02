import { describe, it, expect } from 'vitest'
import {
  scoreContact,
  scoreAccount,
  computeCompleteness,
  type ContactInput,
  type AccountInput,
  type ActiveFlag,
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
  registered_agent_id: 'ra-uuid',
  business_mailing_address_id: 'mailing-uuid',
  business_legal_address_id: null,
}

const NO_SERVICES: string[] = []
const FORMATION_SERVICES = ['Company Formation']
const ITIN_SERVICES = ['ITIN']
const BANKING_SERVICES = ['Banking Fintech']
const CMRA_SERVICES = ['CMRA Mailing Address']

// ── Helper to build flag fixtures ──────────────────────────────────────────

function naFlag(field_name: string): ActiveFlag {
  return { field_name, flag_type: 'na' }
}

function fuFlag(field_name: string): ActiveFlag {
  return { field_name, flag_type: 'follow_up' }
}

// ── Backward compatibility — no flags arg ──────────────────────────────────

describe('scoreContact — backward compatibility (no flags arg)', () => {
  it('still returns green for full contact with no services', () => {
    const r = scoreContact(FULL_CONTACT, NO_SERVICES)
    expect(r.status).toBe('green')
    expect(r.na_fields).toHaveLength(0)
    expect(r.followup_fields).toHaveLength(0)
  })

  it('still returns red when email is missing (no flags)', () => {
    const r = scoreContact({ ...FULL_CONTACT, email: null }, NO_SERVICES)
    expect(r.status).toBe('red')
    expect(r.missing_critical).toContain('Email')
  })
})

describe('scoreAccount — backward compatibility (no flags arg)', () => {
  it('still returns green for complete account', () => {
    const r = scoreAccount(FULL_ACCOUNT, NO_SERVICES)
    expect(r.status).toBe('green')
    expect(r.na_fields).toHaveLength(0)
    expect(r.followup_fields).toHaveLength(0)
  })
})

// ── N/A flags — contact ────────────────────────────────────────────────────

describe('scoreContact — N/A flag removes field from missing', () => {
  it('citizenship N/A clears it from critical when Formation active', () => {
    const r = scoreContact(MINIMAL_CONTACT, FORMATION_SERVICES, [naFlag('citizenship')])
    expect(r.missing_critical).not.toContain('Citizenship')
    expect(r.na_fields).toContain('citizenship')
  })

  it('date_of_birth N/A clears it from critical when Formation active', () => {
    const r = scoreContact(MINIMAL_CONTACT, FORMATION_SERVICES, [naFlag('date_of_birth')])
    expect(r.missing_critical).not.toContain('Date of birth')
    expect(r.na_fields).toContain('date_of_birth')
  })

  it('address_line1 N/A clears Address from critical when Formation active', () => {
    const r = scoreContact(MINIMAL_CONTACT, FORMATION_SERVICES, [naFlag('address_line1')])
    expect(r.missing_critical).not.toContain('Address')
    expect(r.na_fields).toContain('address_line1')
  })

  it('passport_on_file N/A clears it from critical when ITIN active', () => {
    const r = scoreContact(MINIMAL_CONTACT, ITIN_SERVICES, [naFlag('passport_on_file')])
    expect(r.missing_critical).not.toContain('Passport on file')
    expect(r.na_fields).toContain('passport_on_file')
  })

  it('passport_on_file N/A clears it from critical when Banking active', () => {
    const r = scoreContact(MINIMAL_CONTACT, BANKING_SERVICES, [naFlag('passport_on_file')])
    expect(r.missing_critical).not.toContain('Passport on file')
    expect(r.na_fields).toContain('passport_on_file')
  })

  it('itin_number N/A removes it from warnings', () => {
    const r = scoreContact(MINIMAL_CONTACT, NO_SERVICES, [naFlag('itin_number')])
    expect(r.missing_warning).not.toContain('ITIN')
    expect(r.na_fields).toContain('itin_number')
  })

  it('all conditional fields N/A → green dot for MINIMAL contact with Formation active', () => {
    const r = scoreContact(MINIMAL_CONTACT, FORMATION_SERVICES, [
      naFlag('citizenship'),
      naFlag('date_of_birth'),
      naFlag('address_line1'),
      naFlag('itin_number'),
    ])
    expect(r.status).toBe('green')
    expect(r.missing_critical).toHaveLength(0)
    expect(r.missing_warning).toHaveLength(0)
    expect(r.na_fields).toHaveLength(4)
  })

  it('N/A flag on field present in DB has no effect (field present wins)', () => {
    // FULL_CONTACT has citizenship — N/A flag is irrelevant
    const r = scoreContact(FULL_CONTACT, FORMATION_SERVICES, [naFlag('citizenship')])
    expect(r.status).toBe('green')
    expect(r.na_fields).not.toContain('citizenship') // field is present, not flagged
  })
})

describe('scoreContact — critical fields cannot be overridden by N/A flag', () => {
  it('email N/A flag does NOT remove email from missing_critical', () => {
    // email is always required — N/A is not allowed (enforced at API layer)
    // Scoring engine ignores N/A on critical fields
    const r = scoreContact({ ...FULL_CONTACT, email: null }, NO_SERVICES, [naFlag('email')])
    // The scoring engine does NOT check N/A for email — it remains critical
    expect(r.missing_critical).toContain('Email')
    expect(r.na_fields).not.toContain('email')
  })

  it('full_name N/A flag does NOT remove full_name from missing_critical', () => {
    const r = scoreContact({ ...FULL_CONTACT, full_name: '' }, NO_SERVICES, [naFlag('full_name')])
    expect(r.missing_critical).toContain('Full name')
    expect(r.na_fields).not.toContain('full_name')
  })
})

// ── N/A flags — account ────────────────────────────────────────────────────

describe('scoreAccount — N/A flag removes field from missing', () => {
  it('ein_number N/A removes EIN from critical for standard client', () => {
    const r = scoreAccount({ ...FULL_ACCOUNT, ein_number: null }, NO_SERVICES, [naFlag('ein_number')])
    expect(r.missing_critical).not.toContain('EIN')
    expect(r.na_fields).toContain('ein_number')
  })

  it('onboarding_date N/A removes Start date from critical for standard client', () => {
    const r = scoreAccount({ ...FULL_ACCOUNT, onboarding_date: null }, NO_SERVICES, [naFlag('onboarding_date')])
    expect(r.missing_critical).not.toContain('Start date')
    expect(r.na_fields).toContain('onboarding_date')
  })

  it('business_mailing_address_id N/A removes CMRA warning when CMRA active', () => {
    const r = scoreAccount(
      { ...FULL_ACCOUNT, physical_address: null, business_mailing_address_id: null },
      CMRA_SERVICES,
      [naFlag('business_mailing_address_id')],
    )
    expect(r.missing_warning).not.toContain('Mailing address (CMRA active)')
    expect(r.na_fields).toContain('business_mailing_address_id')
    expect(r.status).toBe('green')
  })

  it('both critical account fields N/A → green', () => {
    const r = scoreAccount(
      { ...FULL_ACCOUNT, ein_number: null, onboarding_date: null },
      NO_SERVICES,
      [naFlag('ein_number'), naFlag('onboarding_date')]
    )
    expect(r.status).toBe('green')
    expect(r.na_fields).toHaveLength(2)
  })
})

describe('scoreAccount — critical fields cannot be overridden by N/A flag', () => {
  it('entity_type N/A flag does NOT remove it from critical', () => {
    const r = scoreAccount({ ...FULL_ACCOUNT, entity_type: null }, NO_SERVICES, [naFlag('entity_type')])
    expect(r.missing_critical).toContain('Entity type')
    expect(r.na_fields).not.toContain('entity_type')
  })

  it('state_of_formation N/A flag does NOT remove it from critical', () => {
    const r = scoreAccount({ ...FULL_ACCOUNT, state_of_formation: null }, NO_SERVICES, [naFlag('state_of_formation')])
    expect(r.missing_critical).toContain('State of formation')
    expect(r.na_fields).not.toContain('state_of_formation')
  })
})

// ── Follow-up flags ────────────────────────────────────────────────────────

describe('follow_up flags — tracked in followup_fields, no dot color change', () => {
  it('follow_up on a field does NOT change dot color', () => {
    // MINIMAL contact (no services) would be yellow (ITIN warning)
    // Adding a follow_up flag should not affect status
    const withoutFlag = scoreContact(MINIMAL_CONTACT, NO_SERVICES)
    const withFlag = scoreContact(MINIMAL_CONTACT, NO_SERVICES, [fuFlag('citizenship')])
    expect(withFlag.status).toBe(withoutFlag.status) // no change
  })

  it('follow_up flag appears in followup_fields', () => {
    const r = scoreContact(FULL_CONTACT, NO_SERVICES, [fuFlag('citizenship')])
    expect(r.followup_fields).toContain('citizenship')
  })

  it('multiple follow_up flags all appear in followup_fields', () => {
    const r = scoreContact(FULL_CONTACT, NO_SERVICES, [
      fuFlag('citizenship'),
      fuFlag('date_of_birth'),
    ])
    expect(r.followup_fields).toContain('citizenship')
    expect(r.followup_fields).toContain('date_of_birth')
    expect(r.followup_fields).toHaveLength(2)
  })

  it('follow_up on present field still appears in followup_fields', () => {
    // citizenship is present on FULL_CONTACT — follow_up still tracked
    const r = scoreContact(FULL_CONTACT, NO_SERVICES, [fuFlag('citizenship')])
    expect(r.followup_fields).toContain('citizenship')
    expect(r.status).toBe('green') // no color change
  })

  it('account follow_up flags tracked', () => {
    const r = scoreAccount(FULL_ACCOUNT, NO_SERVICES, [fuFlag('ein_number')])
    expect(r.followup_fields).toContain('ein_number')
    expect(r.status).toBe('green') // no color change
  })
})

// ── Mixed N/A + follow_up ──────────────────────────────────────────────────

describe('mixed N/A + follow_up flags', () => {
  it('N/A and follow_up on same field tracked in their respective arrays', () => {
    // This shouldn't normally happen (same field flagged twice) but we handle it
    const r = scoreContact(MINIMAL_CONTACT, NO_SERVICES, [
      naFlag('itin_number'),
      fuFlag('itin_number'),
    ])
    expect(r.na_fields).toContain('itin_number')
    expect(r.followup_fields).toContain('itin_number')
  })

  it('N/A on one field + follow_up on different field', () => {
    const r = scoreContact(MINIMAL_CONTACT, FORMATION_SERVICES, [
      naFlag('citizenship'),
      naFlag('date_of_birth'),
      naFlag('address_line1'),
      naFlag('itin_number'),
      fuFlag('passport_on_file'),
    ])
    expect(r.status).toBe('green') // all missing fields N/A'd
    expect(r.na_fields).toHaveLength(4)
    expect(r.followup_fields).toContain('passport_on_file')
  })
})

// ── computeCompleteness — flag pass-through ────────────────────────────────

describe('computeCompleteness — flag pass-through', () => {
  it('passes contactFlags to scoreContact', () => {
    const r = computeCompleteness(
      FULL_ACCOUNT,
      MINIMAL_CONTACT,
      FORMATION_SERVICES,
      [naFlag('citizenship'), naFlag('date_of_birth'), naFlag('address_line1'), naFlag('itin_number')],
      [],
    )
    expect(r.contact.status).toBe('green')
    expect(r.contact.na_fields).toHaveLength(4)
  })

  it('passes accountFlags to scoreAccount', () => {
    const r = computeCompleteness(
      { ...FULL_ACCOUNT, ein_number: null },
      FULL_CONTACT,
      NO_SERVICES,
      [],
      [naFlag('ein_number')],
    )
    expect(r.account.status).toBe('green')
    expect(r.account.na_fields).toContain('ein_number')
  })

  it('backward compatible — no flags args', () => {
    const r = computeCompleteness(FULL_ACCOUNT, FULL_CONTACT, NO_SERVICES)
    expect(r.contact.status).toBe('green')
    expect(r.account.status).toBe('green')
  })
})
