/**
 * Unit tests for isContactScopedWizard (lib/portal/wizard-map.ts).
 *
 * Contact-scoped wizards are owned by the buyer-contact and never migrate to
 * the company. The portal must look them up by contact_id, not account_id, so
 * a materialized formation is recognized instead of being re-offered as a
 * duplicate (Lorenzo Cannas, dev_task 21fd1f4a).
 */

import { describe, it, expect } from 'vitest'
import {
  isContactScopedWizard,
  CONTACT_SCOPED_WIZARD_TYPES,
} from '@/lib/portal/wizard-map'

describe('isContactScopedWizard', () => {
  it('returns true for formation (bought by the contact, lives on the contact)', () => {
    expect(isContactScopedWizard('formation')).toBe(true)
  })

  it('returns false for account-owned wizards', () => {
    for (const t of ['onboarding', 'banking', 'banking_payset', 'banking_relay', 'tax', 'closure', 'itin', 'company_info']) {
      expect(isContactScopedWizard(t)).toBe(false)
    }
  })

  it('returns false for unknown / undefined / empty input', () => {
    expect(isContactScopedWizard('nonsense')).toBe(false)
    expect(isContactScopedWizard(undefined)).toBe(false)
    expect(isContactScopedWizard('')).toBe(false)
  })

  it('every declared contact-scoped type is recognized', () => {
    for (const t of CONTACT_SCOPED_WIZARD_TYPES) {
      expect(isContactScopedWizard(t)).toBe(true)
    }
  })
})
