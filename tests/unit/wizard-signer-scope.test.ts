import { describe, it, expect } from 'vitest'
import { wizardCollectsOwnerMembers } from '@/components/portal/wizard/wizard-configs'

// Regression guard for the LUMA Beauty ITIN deadlock (2026-07-24): the SS-4
// Responsible-Party signer requirement must run ONLY on the wizards that render
// an owner + members roster. Any wizard NOT in this allowlist has no signer
// picker, so enforcing the signer there makes Submit impossible for
// multi-member-LLC clients.
describe('wizardCollectsOwnerMembers', () => {
  it('is TRUE for the owner+members wizards that legitimately ask for the SS-4 signer', () => {
    for (const t of ['formation', 'onboarding', 'tax', 'tax_return']) {
      expect(wizardCollectsOwnerMembers(t)).toBe(true)
    }
  })

  it('is FALSE for every wizard with no signer picker (would otherwise deadlock Submit)', () => {
    for (const t of ['itin', 'banking', 'banking_relay', 'banking_payset', 'company_info', 'closure', 'company_closure', 'td_communication']) {
      expect(wizardCollectsOwnerMembers(t)).toBe(false)
    }
  })

  it('is FALSE for unknown / future wizard types (allowlist fails safe)', () => {
    expect(wizardCollectsOwnerMembers('some_new_wizard')).toBe(false)
    expect(wizardCollectsOwnerMembers('')).toBe(false)
  })
})
