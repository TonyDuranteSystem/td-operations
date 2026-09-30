import { describe, it, expect } from 'vitest'
import { formationLeadOwned, formationOfferOwned, onboardingLeadOwned, onboardingOfferOwned, type LeadOwnershipOffer } from '@/lib/portal/formation-lead-access'

const offer = (o: Partial<LeadOwnershipOffer>): LeadOwnershipOffer => ({
  client_email: null,
  contract_type: 'formation',
  contact_id: null,
  ...o,
})
const emails = (...e: string[]) => new Set(e.map(x => x.toLowerCase()))

describe('formationLeadOwned', () => {
  it('owns via contact_id match (auto-anchor offers)', () => {
    expect(formationLeadOwned(offer({ contact_id: 'C1' }), 'C1', emails())).toBe(true)
  })

  it('owns via client_email match (legacy offers without contact_id)', () => {
    expect(
      formationLeadOwned(offer({ client_email: 'Cotti_Michele@LIBERO.it' }), 'C1', emails('cotti_michele@libero.it')),
    ).toBe(true)
  })

  it('owns when contact_id matches even if email differs', () => {
    expect(
      formationLeadOwned(offer({ contact_id: 'C1', client_email: 'other@x.com' }), 'C1', emails('me@x.com')),
    ).toBe(true)
  })

  it('BLOCKS when neither contact_id nor email match (tampered lead_id)', () => {
    expect(
      formationLeadOwned(offer({ contact_id: 'C2', client_email: 'someone@else.com' }), 'C1', emails('me@x.com')),
    ).toBe(false)
  })

  it('BLOCKS a non-formation offer for the lead', () => {
    expect(formationLeadOwned(offer({ contract_type: 'renewal', contact_id: 'C1' }), 'C1', emails())).toBe(false)
  })

  it('BLOCKS when no offer exists for the lead', () => {
    expect(formationLeadOwned(null, 'C1', emails('me@x.com'))).toBe(false)
  })

  it('does not match a different contact via contact_id', () => {
    expect(formationLeadOwned(offer({ contact_id: 'C2' }), 'C1', emails())).toBe(false)
  })
})

// dev job bc2a8f7f (2026-09-20) — onboarding's own version of the same
// hijack backstop, for a returning client bringing a second, brand-new
// company. Mirrors formationLeadOwned's coverage exactly, with 'onboarding'
// as the expected contract_type instead of 'formation'.
describe('onboardingLeadOwned', () => {
  const onboardingOffer = (o: Partial<LeadOwnershipOffer>): LeadOwnershipOffer => ({
    client_email: null,
    contract_type: 'onboarding',
    contact_id: null,
    ...o,
  })

  it('owns via contact_id match', () => {
    expect(onboardingLeadOwned(onboardingOffer({ contact_id: 'C1' }), 'C1', emails())).toBe(true)
  })

  it('owns via client_email match', () => {
    expect(
      onboardingLeadOwned(onboardingOffer({ client_email: 'Cotti_Michele@LIBERO.it' }), 'C1', emails('cotti_michele@libero.it')),
    ).toBe(true)
  })

  it('BLOCKS when neither contact_id nor email match (tampered lead_id)', () => {
    expect(
      onboardingLeadOwned(onboardingOffer({ contact_id: 'C2', client_email: 'someone@else.com' }), 'C1', emails('me@x.com')),
    ).toBe(false)
  })

  it('BLOCKS a formation offer for the lead (contract_type must be onboarding specifically)', () => {
    expect(onboardingLeadOwned(onboardingOffer({ contract_type: 'formation', contact_id: 'C1' }), 'C1', emails())).toBe(false)
  })

  it('a FORMATION lead is never accepted by onboardingLeadOwned, and vice versa (no cross-type confusion)', () => {
    const formationOnlyOffer = onboardingOffer({ contract_type: 'formation', contact_id: 'C1' })
    expect(onboardingLeadOwned(formationOnlyOffer, 'C1', emails())).toBe(false)
    expect(formationLeadOwned(formationOnlyOffer, 'C1', emails())).toBe(true)

    const onboardingOnlyOffer = onboardingOffer({ contact_id: 'C1' })
    expect(formationLeadOwned(onboardingOnlyOffer, 'C1', emails())).toBe(false)
    expect(onboardingLeadOwned(onboardingOnlyOffer, 'C1', emails())).toBe(true)
  })

  it('BLOCKS when no offer exists for the lead', () => {
    expect(onboardingLeadOwned(null, 'C1', emails('me@x.com'))).toBe(false)
  })
})

// Workspace-only plan S1 (dev job 9d34e750, 2026-09-27) — an existing client's
// NEW company formation has no lead; the offer itself is the anchor, exactly
// like onboardingOfferOwned for a returning client's second+ onboarding.
describe('formationOfferOwned', () => {
  it('owns via contact_id match (offer created on the contact page, no lead)', () => {
    expect(formationOfferOwned(offer({ contact_id: 'C1' }), 'C1', emails())).toBe(true)
  })

  it('owns via client_email match', () => {
    expect(
      formationOfferOwned(offer({ client_email: 'Me@X.com' }), 'C1', emails('me@x.com')),
    ).toBe(true)
  })

  it('BLOCKS a tampered offer id belonging to someone else', () => {
    expect(
      formationOfferOwned(offer({ contact_id: 'C2', client_email: 'someone@else.com' }), 'C1', emails('me@x.com')),
    ).toBe(false)
  })

  it('BLOCKS an onboarding offer (no cross-type confusion)', () => {
    const onb = offer({ contract_type: 'onboarding', contact_id: 'C1' })
    expect(formationOfferOwned(onb, 'C1', emails())).toBe(false)
    expect(onboardingOfferOwned(onb, 'C1', emails())).toBe(true)
  })

  it('BLOCKS when the offer does not exist', () => {
    expect(formationOfferOwned(null, 'C1', emails('me@x.com'))).toBe(false)
  })
})
