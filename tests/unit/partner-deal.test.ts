import { describe, it, expect } from 'vitest'
import { buildPartnerDeal, shouldRunReferralCredit, parsePartnerDeal, shouldPayRenewal, splitRenewalPayout, renewalShareForInstallment } from '@/lib/partners/partner-deal'

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

describe('parsePartnerDeal', () => {
  it('parses a stored jsonb deal', () => {
    expect(parsePartnerDeal({ setup_payout: 2500, renewal_payout: 500, currency: 'USD', offer_token: 'davide-priori-2026' }))
      .toEqual({ setup_payout: 2500, renewal_payout: 500, currency: 'USD', offer_token: 'davide-priori-2026' })
  })

  it('returns null for null/non-object input', () => {
    expect(parsePartnerDeal(null)).toBeNull()
    expect(parsePartnerDeal('nope')).toBeNull()
  })

  it('defaults currency to USD and tolerates string numbers', () => {
    expect(parsePartnerDeal({ setup_payout: '2500', renewal_payout: '500' }))
      .toEqual({ setup_payout: 2500, renewal_payout: 500, currency: 'USD', offer_token: null })
  })
})

describe('shouldPayRenewal (formation-year guard)', () => {
  const deal = { setup_payout: 2500, renewal_payout: 500, currency: 'USD', offer_token: null }

  it('pays the renewal share in a year AFTER formation', () => {
    expect(shouldPayRenewal({ partnerDeal: deal, formationYear: 2026, paymentYear: 2027 }))
      .toEqual({ pay: true, amount: 500, reason: 'ok' })
  })

  it('does NOT pay in the formation year (setup already paid that cycle)', () => {
    expect(shouldPayRenewal({ partnerDeal: deal, formationYear: 2026, paymentYear: 2026 }))
      .toEqual({ pay: false, amount: 0, reason: 'formation_year' })
  })

  it('does not pay when there is no renewal amount', () => {
    expect(shouldPayRenewal({ partnerDeal: { ...deal, renewal_payout: null }, formationYear: 2026, paymentYear: 2027 }))
      .toEqual({ pay: false, amount: 0, reason: 'no_renewal_deal' })
    expect(shouldPayRenewal({ partnerDeal: null, formationYear: 2026, paymentYear: 2027 }).reason).toBe('no_renewal_deal')
  })

  it('does not pay (flags) when the formation year is unknown — avoids a wrong payout', () => {
    expect(shouldPayRenewal({ partnerDeal: deal, formationYear: null, paymentYear: 2027 }))
      .toEqual({ pay: false, amount: 0, reason: 'unknown_formation_year' })
  })

  it('pays every year after formation (recurring, indefinite)', () => {
    for (const y of [2027, 2028, 2035]) {
      expect(shouldPayRenewal({ partnerDeal: deal, formationYear: 2026, paymentYear: y }).pay).toBe(true)
    }
  })
})

describe('splitRenewalPayout / renewalShareForInstallment', () => {
  it('splits an even total 50/50', () => {
    expect(splitRenewalPayout(500, 2)).toEqual([250, 250])
  })

  it('last installment absorbs the rounding remainder (sums to total)', () => {
    const parts = splitRenewalPayout(501, 2)
    expect(parts[0]).toBe(250.5)
    expect(parts[1]).toBe(250.5)
    expect(parts[0] + parts[1]).toBe(501)
  })

  it('odd-cent total still sums exactly', () => {
    const parts = splitRenewalPayout(333.33, 2)
    expect(Math.round((parts[0] + parts[1]) * 100) / 100).toBe(333.33)
  })

  it('returns [] for non-positive or invalid totals', () => {
    expect(splitRenewalPayout(0, 2)).toEqual([])
    expect(splitRenewalPayout(-100, 2)).toEqual([])
    expect(splitRenewalPayout(NaN, 2)).toEqual([])
  })

  it('renewalShareForInstallment picks the right 1-based part, 0 out of range', () => {
    expect(renewalShareForInstallment(500, 1)).toBe(250)
    expect(renewalShareForInstallment(500, 2)).toBe(250)
    expect(renewalShareForInstallment(500, 3)).toBe(0)
    expect(renewalShareForInstallment(0, 1)).toBe(0)
  })
})
