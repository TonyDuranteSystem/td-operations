import { describe, it, expect } from 'vitest'
import { buildPartnerDeal, shouldRunReferralCredit } from '@/lib/partners/partner-deal'

describe('shouldRunReferralCredit (double-pay guard)', () => {
  it('runs the referral credit for a plain referrer (no partner)', () => {
    expect(shouldRunReferralCredit({ referrer_name: 'Andrea Bosco', partner_id: null })).toBe(true)
  })

  it('SKIPS the referral credit when the offer is driven by a managed partner', () => {
    // Auralba case: partner offer → partner-payout path handles it; running both double-pays.
    expect(shouldRunReferralCredit({ referrer_name: 'Auralba Grifa', partner_id: 'partner-1' })).toBe(false)
  })

  it('does nothing when there is no referrer at all', () => {
    expect(shouldRunReferralCredit({ referrer_name: null, partner_id: null })).toBe(false)
    expect(shouldRunReferralCredit({})).toBe(false)
  })
})

describe('buildPartnerDeal', () => {
  it('builds a deal with setup + renewal in USD (Auralba: $2,500 setup / $500 renewal)', () => {
    expect(buildPartnerDeal({ partnerId: 'p1', setupPayout: 2500, renewalPayout: 500, offerToken: 'davide-priori-2026' }))
      .toEqual({ setup_payout: 2500, renewal_payout: 500, currency: 'USD', offer_token: 'davide-priori-2026' })
  })

  it('returns null when there is no partner', () => {
    expect(buildPartnerDeal({ partnerId: null, setupPayout: 2500, renewalPayout: 500 })).toBeNull()
  })

  it('returns null when there are no positive amounts (never stamps an empty deal)', () => {
    expect(buildPartnerDeal({ partnerId: 'p1', setupPayout: 0, renewalPayout: null })).toBeNull()
    expect(buildPartnerDeal({ partnerId: 'p1', setupPayout: null, renewalPayout: -5 })).toBeNull()
  })

  it('keeps a setup-only or renewal-only deal', () => {
    expect(buildPartnerDeal({ partnerId: 'p1', setupPayout: 2500, renewalPayout: null }))
      .toEqual({ setup_payout: 2500, renewal_payout: null, currency: 'USD', offer_token: null })
    expect(buildPartnerDeal({ partnerId: 'p1', setupPayout: null, renewalPayout: 500 }))
      .toEqual({ setup_payout: null, renewal_payout: 500, currency: 'USD', offer_token: null })
  })

  it('uppercases an explicit currency', () => {
    expect(buildPartnerDeal({ partnerId: 'p1', setupPayout: 100, renewalPayout: null, currency: 'eur' }).currency).toBe('EUR')
  })
})
