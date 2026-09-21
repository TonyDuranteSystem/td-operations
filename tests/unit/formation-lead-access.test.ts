import { describe, it, expect } from 'vitest'
import { formationLeadOwned, onboardingLeadOwned, type LeadOwnershipOffer } from '@/lib/portal/formation-lead-access'

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
