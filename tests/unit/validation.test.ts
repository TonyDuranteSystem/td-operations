import { describe, it, expect } from 'vitest'
import {
  validateEIN,
  normalizeEIN,
  validateState,
  validateFormationDate,
  validateRequiredFields,
  validateOnboardingData,
  validateFormationData,
  validateWizardData,
} from '../../lib/jobs/validation'

describe('normalizeEIN', () => {
  it('formats 9-digit input with canonical dash', () => {
    expect(normalizeEIN('334119609')).toBe('33-4119609')
    expect(normalizeEIN('301482516')).toBe('30-1482516')
  })

  it('preserves already-canonical input', () => {
    expect(normalizeEIN('30-1482516')).toBe('30-1482516')
  })

  it('strips any non-digit separators', () => {
    expect(normalizeEIN('30 1482516')).toBe('30-1482516')
    expect(normalizeEIN('30.1482516')).toBe('30-1482516')
    expect(normalizeEIN('3-01-48-2516')).toBe('30-1482516')
  })

  it('returns null when digit count is not 9', () => {
    expect(normalizeEIN('12345678')).toBeNull()
    expect(normalizeEIN('1234567890')).toBeNull()
    expect(normalizeEIN('abc-defghij')).toBeNull()
    expect(normalizeEIN('')).toBeNull()
    expect(normalizeEIN(null)).toBeNull()
    expect(normalizeEIN(undefined)).toBeNull()
  })
})

describe('validateEIN', () => {
  it('accepts canonical XX-XXXXXXX format', () => {
    expect(validateEIN('30-1482516')).toBeNull()
    expect(validateEIN('12-3456789')).toBeNull()
  })

  it('accepts 9-digit unformatted input (real-world client entry)', () => {
    expect(validateEIN('334119609')).toBeNull() // Luca Gallacci 2026-04-18
    expect(validateEIN('301482516')).toBeNull()
  })

  it('accepts 9 digits with any separator', () => {
    expect(validateEIN('30 1482516')).toBeNull()
    expect(validateEIN('3-01482516')).toBeNull()
  })

  it('rejects wrong digit count', () => {
    expect(validateEIN('30-148251')).not.toBeNull()     // 8 digits
    expect(validateEIN('12345678')).not.toBeNull()      // 8 digits
    expect(validateEIN('1234567890')).not.toBeNull()    // 10 digits
    expect(validateEIN('abc-defghij')).not.toBeNull()   // no digits
  })

  it('returns null for missing EIN (optional)', () => {
    expect(validateEIN(null)).toBeNull()
    expect(validateEIN(undefined)).toBeNull()
    expect(validateEIN('')).toBeNull()
  })

  it('trims whitespace', () => {
    expect(validateEIN(' 30-1482516 ')).toBeNull()
    expect(validateEIN(' 334119609 ')).toBeNull()
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

describe('validateWizardData (dispatcher)', () => {
  const validOnboarding = {
    company_name: 'Test LLC',
    owner_first_name: 'John',
    owner_last_name: 'Doe',
    ein: '30-1482516',
  }

  const validFormation = {
    owner_first_name: 'John',
    owner_last_name: 'Doe',
    llc_name_1: 'My New LLC',
  }

  it('routes "onboarding" to validateOnboardingData', () => {
    const direct = validateOnboardingData(validOnboarding)
    const viaDispatcher = validateWizardData('onboarding', validOnboarding)
    expect(viaDispatcher).toEqual(direct)
  })

  it('routes "formation" to validateFormationData', () => {
    const direct = validateFormationData(validFormation)
    const viaDispatcher = validateWizardData('formation', validFormation)
    expect(viaDispatcher).toEqual(direct)
  })

  it('surfaces invalid EIN via onboarding dispatcher (Luca Gallacci regression)', () => {
    const result = validateWizardData('onboarding', { ...validOnboarding, ein: 'bad' })
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.field === 'ein')).toBe(true)
  })

  it('accepts 9-digit EIN without dashes via dispatcher', () => {
    const result = validateWizardData('onboarding', { ...validOnboarding, ein: '334119609' })
    expect(result.valid).toBe(true)
  })

  it('passes through (valid) for wizard types without a dedicated validator', () => {
    // Phase A ships dispatchers for onboarding + formation only. Others are
    // expected to pass through unchanged so the route boundary never blocks
    // a submission for a wizard type we haven't yet written a validator for.
    const passThroughTypes = ['tax', 'itin', 'closure', 'banking', 'banking_payset', 'banking_relay', 'company_info']
    for (const wt of passThroughTypes) {
      const result = validateWizardData(wt, { some: 'data' })
      expect(result.valid, `wizard type "${wt}" must passthrough`).toBe(true)
      expect(result.errors).toHaveLength(0)
    }
  })

  it('passes through for unknown wizard types', () => {
    const result = validateWizardData('not-a-real-type', {})
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('catches missing required fields via dispatcher', () => {
    const result = validateWizardData('onboarding', { company_name: 'Only This' })
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors.some(e => e.field === 'owner_first_name')).toBe(true)
    expect(result.errors.some(e => e.field === 'owner_last_name')).toBe(true)
  })
})
