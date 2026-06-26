import { describe, it, expect } from 'vitest'
import { computeReferralProgress, isPayoutRequestable } from '@/lib/portal/partner-referrals'

const base = { offerStatus: 'draft', hasCallSummary: false, hasSetupPayout: false, hasRenewalPayout: false }

describe('computeReferralProgress', () => {
  it('draft offer with a logged call → only Call done', () => {
    expect(computeReferralProgress({ ...base, offerStatus: 'draft', hasCallSummary: true }))
      .toEqual({ call_done: true, offer_sent: false, client_signed: false, client_paid: false, annual_renewal: false })
  })

  it('sent offer → Call done + Offer sent (monotonic: call implied even without a summary)', () => {
    expect(computeReferralProgress({ ...base, offerStatus: 'sent' }))
      .toEqual({ call_done: true, offer_sent: true, client_signed: false, client_paid: false, annual_renewal: false })
  })

  it('signed offer → through Client signed', () => {
    expect(computeReferralProgress({ ...base, offerStatus: 'signed' }))
      .toEqual({ call_done: true, offer_sent: true, client_signed: true, client_paid: false, annual_renewal: false })
  })

  it('completed offer → through Client paid', () => {
    expect(computeReferralProgress({ ...base, offerStatus: 'completed' }))
      .toEqual({ call_done: true, offer_sent: true, client_signed: true, client_paid: true, annual_renewal: false })
  })

  it('a setup payout marks Client paid even if the offer status lags', () => {
    expect(computeReferralProgress({ ...base, offerStatus: 'signed', hasSetupPayout: true }))
      .toEqual({ call_done: true, offer_sent: true, client_signed: true, client_paid: true, annual_renewal: false })
  })

  it('a renewal payout lights Annual renewal', () => {
    expect(computeReferralProgress({ ...base, offerStatus: 'completed', hasSetupPayout: true, hasRenewalPayout: true }))
      .toEqual({ call_done: true, offer_sent: true, client_signed: true, client_paid: true, annual_renewal: true })
  })

  it('is monotonic — never a checked stage after an unchecked earlier one', () => {
    for (const status of ['draft', 'sent', 'viewed', 'signed', 'completed', 'expired', null]) {
      for (const hasCallSummary of [false, true]) {
        for (const hasSetupPayout of [false, true]) {
          const p = computeReferralProgress({ offerStatus: status, hasCallSummary, hasSetupPayout, hasRenewalPayout: false })
          const order = [p.call_done, p.offer_sent, p.client_signed, p.client_paid]
          const firstFalse = order.indexOf(false)
          if (firstFalse !== -1) {
            // everything after the first false must also be false
            expect(order.slice(firstFalse).every(v => v === false)).toBe(true)
          }
        }
      }
    }
  })
})

describe('isPayoutRequestable', () => {
  it('pending payouts are requestable; requested/approved/paid are not', () => {
    expect(isPayoutRequestable('pending')).toBe(true)
    expect(isPayoutRequestable('requested')).toBe(false)
    expect(isPayoutRequestable('approved')).toBe(false)
    expect(isPayoutRequestable('paid')).toBe(false)
    expect(isPayoutRequestable(null)).toBe(false)
  })
})
