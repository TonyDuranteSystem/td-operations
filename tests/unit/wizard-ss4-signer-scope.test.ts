import { describe, it, expect } from 'vitest'
import { wizardCollectsOwnerMembers, wizardRequiresSs4Signer } from '@/components/portal/wizard/wizard-configs'

describe('wizardRequiresSs4Signer', () => {
  it('applies to the EIN-application wizards', () => {
    expect(wizardRequiresSs4Signer('formation')).toBe(true)
    expect(wizardRequiresSs4Signer('onboarding')).toBe(true)
  })

  it('does NOT apply to tax — both spellings', () => {
    // The bug: a multi-member client completed the whole tax questionnaire and
    // was refused at the last step by a toast about a tick box several steps
    // back. Nothing in the tax pipeline reads the signer, and by tax season the
    // EIN already exists.
    expect(wizardRequiresSs4Signer('tax')).toBe(false)
    expect(wizardRequiresSs4Signer('tax_return')).toBe(false)
  })

  it('does not leak to wizards with no members step', () => {
    for (const w of ['itin', 'banking', 'banking_relay', 'company_info', 'closure', 'td_communication', 'anything_new']) {
      expect(wizardRequiresSs4Signer(w)).toBe(false)
    }
  })

  it('is strictly narrower than the members-roster allowlist', () => {
    // Every wizard needing a signer must also collect members; the reverse is
    // NOT true — tax collects members but needs no signer.
    for (const w of ['formation', 'onboarding', 'tax', 'tax_return', 'itin', 'closure']) {
      if (wizardRequiresSs4Signer(w)) expect(wizardCollectsOwnerMembers(w)).toBe(true)
    }
    expect(wizardCollectsOwnerMembers('tax')).toBe(true)
    expect(wizardRequiresSs4Signer('tax')).toBe(false)
  })

  it('keeps tax in the members-roster allowlist — the 100% ownership rule still runs', () => {
    // Guard against the tempting wrong fix: dropping tax from
    // wizardCollectsOwnerMembers would also disable the check that member
    // shares total 100%, which a partnership return depends on for the K-1s.
    expect(wizardCollectsOwnerMembers('tax')).toBe(true)
    expect(wizardCollectsOwnerMembers('tax_return')).toBe(true)
  })
})
