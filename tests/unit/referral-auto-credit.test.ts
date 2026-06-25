import { describe, it, expect } from 'vitest'
import { decideReferralAutoCredit, resolveOfferCommission } from '@/lib/operations/referral'

describe('decideReferralAutoCredit', () => {
  it('auto-credits when there is a referrer account and a positive amount', () => {
    expect(decideReferralAutoCredit({ commissionAmount: 250, referrerAccountId: 'acc-1' }))
      .toEqual({ autoCredit: true, reason: 'ok' })
  })

  it('falls back to manual when there is no referrer account (credit would have nowhere to land)', () => {
    expect(decideReferralAutoCredit({ commissionAmount: 250, referrerAccountId: null }))
      .toEqual({ autoCredit: false, reason: 'no_referrer_account' })
    expect(decideReferralAutoCredit({ commissionAmount: 250, referrerAccountId: undefined }))
      .toEqual({ autoCredit: false, reason: 'no_referrer_account' })
  })

  it('falls back to manual when the commission amount is zero/negative/missing', () => {
    expect(decideReferralAutoCredit({ commissionAmount: 0, referrerAccountId: 'acc-1' }))
      .toEqual({ autoCredit: false, reason: 'zero_amount' })
    expect(decideReferralAutoCredit({ commissionAmount: null, referrerAccountId: 'acc-1' }))
      .toEqual({ autoCredit: false, reason: 'zero_amount' })
    expect(decideReferralAutoCredit({ commissionAmount: -100, referrerAccountId: 'acc-1' }))
      .toEqual({ autoCredit: false, reason: 'zero_amount' })
  })

  it('checks the account before the amount (account is the hard blocker)', () => {
    // no account AND zero amount → reports the account problem first
    expect(decideReferralAutoCredit({ commissionAmount: 0, referrerAccountId: null }))
      .toEqual({ autoCredit: false, reason: 'no_referrer_account' })
  })
})

describe('resolveOfferCommission', () => {
  it('client referral with no explicit type → credit_note, 10%, USD (Dionisie case: €2,500 → 250)', () => {
    expect(resolveOfferCommission({ referrer_type: 'client' }, 2500))
      .toEqual({ commissionType: 'credit_note', commissionPct: 10, commissionAmount: 250, commissionCurrency: 'USD' })
  })

  it('null referrer_type defaults to a client credit_note', () => {
    expect(resolveOfferCommission({}, 2000))
      .toEqual({ commissionType: 'credit_note', commissionPct: 10, commissionAmount: 200, commissionCurrency: 'USD' })
  })

  it('partner → price_difference of (agreedPrice − setupFee), pct null, USD', () => {
    expect(resolveOfferCommission({ referrer_type: 'partner', referrer_agreed_price: 3000 }, 2500))
      .toEqual({ commissionType: 'price_difference', commissionPct: null, commissionAmount: 500, commissionCurrency: 'USD' })
  })

  it('honors an explicit commission type + pct override', () => {
    expect(resolveOfferCommission({ referrer_commission_type: 'percentage', referrer_commission_pct: 15 }, 2000))
      .toEqual({ commissionType: 'percentage', commissionPct: 15, commissionAmount: 300, commissionCurrency: 'USD' })
  })

  it('zero setup fee → zero amount (will fall back to manual via decideReferralAutoCredit)', () => {
    const r = resolveOfferCommission({ referrer_type: 'client' }, 0)
    expect(r.commissionAmount).toBe(0)
    expect(decideReferralAutoCredit({ commissionAmount: r.commissionAmount, referrerAccountId: 'acc-1' }).autoCredit).toBe(false)
  })

  it('partner with agreedPrice below the base → NEGATIVE amount → not auto-credited (no negative credit note)', () => {
    const r = resolveOfferCommission({ referrer_type: 'partner', referrer_agreed_price: 2000 }, 2500)
    expect(r.commissionAmount).toBe(-500)
    expect(decideReferralAutoCredit({ commissionAmount: r.commissionAmount, referrerAccountId: 'acc-1' }))
      .toEqual({ autoCredit: false, reason: 'zero_amount' })
  })

  it('always returns USD currency regardless of type', () => {
    expect(resolveOfferCommission({ referrer_type: 'client' }, 1000).commissionCurrency).toBe('USD')
    expect(resolveOfferCommission({ referrer_type: 'partner', referrer_agreed_price: 1 }, 0).commissionCurrency).toBe('USD')
  })
})
