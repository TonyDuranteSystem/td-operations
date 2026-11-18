import { describe, it, expect } from 'vitest'
import {
  LOGIN_EMAIL_FIELD,
  forceLoginEmail,
  isLoginEmailWizard,
  loginEmailLock,
  mustReadAckKey,
} from '@/lib/portal/login-email-field'

describe('isLoginEmailWizard', () => {
  it('is true for the two wizards that share the Owner step', () => {
    expect(isLoginEmailWizard('formation')).toBe(true)
    expect(isLoginEmailWizard('onboarding')).toBe(true)
  })
  it('is false for every other wizard and for empty input', () => {
    for (const w of ['tax', 'banking', 'itin', 'closure', 'td_communication', 'company_info', '', null, undefined]) {
      expect(isLoginEmailWizard(w as string | null | undefined)).toBe(false)
    }
  })
})

describe('loginEmailLock', () => {
  const base = { wizardType: 'formation', contactId: 'c1', authEmail: 'maria@example.com' }
  it('locks to the login email for a normal client', () => {
    expect(loginEmailLock(base)).toBe('maria@example.com')
    expect(loginEmailLock({ ...base, wizardType: 'onboarding' })).toBe('maria@example.com')
  })
  it('trims the login email', () => {
    expect(loginEmailLock({ ...base, authEmail: '  maria@example.com ' })).toBe('maria@example.com')
  })
  it('does not lock a team login (no contact)', () => {
    expect(loginEmailLock({ ...base, contactId: null })).toBeNull()
    expect(loginEmailLock({ ...base, contactId: '' })).toBeNull()
    expect(loginEmailLock({ ...base, contactId: undefined })).toBeNull()
  })
  it('does not lock when the login has no email', () => {
    expect(loginEmailLock({ ...base, authEmail: null })).toBeNull()
    expect(loginEmailLock({ ...base, authEmail: '   ' })).toBeNull()
  })
  it('does not lock a wizard that has no such box', () => {
    expect(loginEmailLock({ ...base, wizardType: 'tax' })).toBeNull()
    expect(loginEmailLock({ ...base, wizardType: 'banking' })).toBeNull()
  })
})

describe('forceLoginEmail', () => {
  const data = { owner_first_name: 'Maria', owner_email: 'typed-by-browser@example.com', llc_name_1: 'Acme LLC' }
  it('overwrites whatever the browser sent for the owner email', () => {
    const out = forceLoginEmail({ wizardType: 'formation', contactId: 'c1', authEmail: 'maria@example.com', data })
    expect(out[LOGIN_EMAIL_FIELD]).toBe('maria@example.com')
    expect(out.owner_first_name).toBe('Maria')
    expect(out.llc_name_1).toBe('Acme LLC')
  })
  it('adds the owner email when the browser sent none', () => {
    const out = forceLoginEmail({ wizardType: 'onboarding', contactId: 'c1', authEmail: 'maria@example.com', data: { owner_first_name: 'Maria' } })
    expect(out.owner_email).toBe('maria@example.com')
  })
  it('does not change the input object', () => {
    const copy = { ...data }
    forceLoginEmail({ wizardType: 'formation', contactId: 'c1', authEmail: 'maria@example.com', data })
    expect(data).toEqual(copy)
  })
  it('returns the same data when the box is not locked', () => {
    expect(forceLoginEmail({ wizardType: 'formation', contactId: null, authEmail: 'maria@example.com', data })).toBe(data)
    expect(forceLoginEmail({ wizardType: 'tax', contactId: 'c1', authEmail: 'maria@example.com', data })).toBe(data)
    expect(forceLoginEmail({ wizardType: 'formation', contactId: 'c1', authEmail: '', data })).toBe(data)
  })
})

describe('mustReadAckKey', () => {
  it('derives the tick key from the field name', () => {
    expect(mustReadAckKey('owner_email')).toBe('owner_email_read')
  })
})
