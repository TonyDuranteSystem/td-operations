import { describe, it, expect } from 'vitest'
import {
  validateEIN,
  validateState,
  validateFormationDate,
  validateRequiredFields,
  validateOnboardingData,
  validateFormationData,
} from '../../lib/jobs/validation'

describe('validateEIN', () => {
  it('accepts valid EIN format', () => {
    expect(validateEIN('30-1482516')).toBeNull()
    expect(validateEIN('12-3456789')).toBeNull()
  })

  it('rejects invalid EIN formats', () => {
    expect(validateEIN('301482516')).not.toBeNull()
    expect(validateEIN('30-148251')).not.toBeNull()
    expect(validateEIN('abc-defghij')).not.toBeNull()
    expect(validateEIN('3-01482516')).not.toBeNull()
  })

  it('returns null for missing EIN (optional)', () => {
    expect(validateEIN(null)).toBeNull()
    expect(validateEIN(undefined)).toBeNull()
    expect(validateEIN('')).toBeNull()
  })

  it('trims whitespace', () => {
    expect(validateEIN(' 30-1482516 ')).toBeNull()
  })
})

describe('validateState', () => {
  it('accepts known states', () => {
    expect(validateState('NM')).toBeNull()
    expect(validateState('New Mexico')).toBeNull()
    expect(validateState('WY')).toBeNull()
    expect(validateState('FL')).toBeNull()
    expect(validateState('DE')).toBeNull()
    expect(validateState('Delaware')).toBeNull()
  })

  it('warns about unknown states', () => {
    const result = validateState('Texas')
    expect(result).not.toBeNull()
    expect(result?.severity).toBe('warning')
  })

  it('returns null for missing state', () => {
    expect(validateState(null)).toBeNull()
    expect(validateState(undefined)).toBeNull()
  })
})

describe('validateFormationDate', () => {
  it('accepts valid dates', () => {
    expect(validateFormationDate('2024-01-15')).toBeNull()
    expect(validateFormationDate('2020-06-30')).toBeNull()
  })

  it('warns about future dates', () => {
    const result = validateFormationDate('2099-01-01')
    expect(result).not.toBeNull()
    expect(result?.severity).toBe('warning')
  })

  it('warns about very old dates', () => {
    const result = validateFormationDate('1980-01-01')
    expect(result).not.toBeNull()
    expect(result?.severity).toBe('warning')
  })

  it('errors on invalid date format', () => {
    const result = validateFormationDate('not-a-date')
    expect(result).not.toBeNull()
    expect(result?.severity).toBe('error')
  })

  it('returns null for missing date', () => {
    expect(validateFormationDate(null)).toBeNull()
  })
})

describe('validateRequiredFields', () => {
  it('passes when all fields present', () => {
    const data = { name: 'John', email: 'john@test.com' }
    expect(validateRequiredFields(data, ['name', 'email'])).toHaveLength(0)
  })

  it('reports missing fields', () => {
    const data = { name: 'John' }
    const errors = validateRequiredFields(data, ['name', 'email'])
    expect(errors).toHaveLength(1)
    expect(errors[0].field).toBe('email')
  })

  it('reports empty string fields', () => {
    const data = { name: '', email: 'john@test.com' }
    const errors = validateRequiredFields(data, ['name', 'email'])
    expect(errors).toHaveLength(1)
    expect(errors[0].field).toBe('name')
  })
})

describe('validateOnboardingData', () => {
  it('validates complete onboarding data', () => {
    const data = {
      company_name: 'Test LLC',
      owner_first_name: 'John',
      owner_last_name: 'Doe',
      ein: '30-1482516',
      state_of_formation: 'NM',
      formation_date: '2024-01-15',
    }
    const result = validateOnboardingData(data)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('fails on missing required fields', () => {
    const data = { ein: '30-1482516' }
    const result = validateOnboardingData(data)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('fails on invalid EIN', () => {
    const data = {
      company_name: 'Test LLC',
      owner_first_name: 'John',
      owner_last_name: 'Doe',
      ein: 'bad-ein',
    }
    const result = validateOnboardingData(data)
    expect(result.valid).toBe(false)
  })

  it('warns on unusual state', () => {
    const data = {
      company_name: 'Test LLC',
      owner_first_name: 'John',
      owner_last_name: 'Doe',
      state_of_formation: 'Texas',
    }
    const result = validateOnboardingData(data)
    expect(result.valid).toBe(true) // warnings don't block
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})

describe('validateFormationData', () => {
  it('validates complete formation data', () => {
    const data = {
      owner_first_name: 'John',
      owner_last_name: 'Doe',
      llc_name_1: 'My New LLC',
    }
    const result = validateFormationData(data)
    expect(result.valid).toBe(true)
  })

  it('fails on missing LLC name', () => {
    const data = {
      owner_first_name: 'John',
      owner_last_name: 'Doe',
    }
    const result = validateFormationData(data)
    expect(result.valid).toBe(false)
  })
})
