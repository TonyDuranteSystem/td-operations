import { describe, it, expect } from 'vitest'
import { decideReferralAutoCredit } from '@/lib/operations/referral'

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
