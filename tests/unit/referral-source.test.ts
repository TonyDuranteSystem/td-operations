import { describe, it, expect } from 'vitest'
import {
  offerTokenOfInvoice,
  offerReferrerName,
  parseOfferSetupFee,
  setupFeeFromSignedOffers,
  SIGNED_OFFER_STATUSES,
} from '@/lib/referrals/referral-source'

describe('offerTokenOfInvoice — which offer an invoice belongs to', () => {
  it('reads the token from the signing invoice key', () => {
    expect(offerTokenOfInvoice({ idempotency_key: 'offer-signed:franco-ronaldi-2026' })).toBe('franco-ronaldi-2026')
  })

  it('drops the contact id older signing keys carried', () => {
    const key = 'offer-signed:alex-tumbarello-2026:3f2b8a52-6d1c-4c0a-9d77-1a2b3c4d5e6f'
    expect(offerTokenOfInvoice({ idempotency_key: key })).toBe('alex-tumbarello-2026')
  })

  it('keeps a token that itself ends in digits and dashes (not a UUID)', () => {
    expect(offerTokenOfInvoice({ idempotency_key: 'offer-signed:zz-t22-B-17919828328212' })).toBe('zz-t22-B-17919828328212')
  })

  it('a plan part names its offer directly, and that wins over the key', () => {
    expect(offerTokenOfInvoice({ idempotency_key: 'offer-tranche:abc-2026:2', tranche_offer_token: 'abc-2026' })).toBe('abc-2026')
    expect(offerTokenOfInvoice({ idempotency_key: 'offer-signed:one', tranche_offer_token: 'two' })).toBe('two')
  })

  it('is null for every other invoice', () => {
    expect(offerTokenOfInvoice({ idempotency_key: 'annual-installment:acct:2:2026' })).toBeNull()
    expect(offerTokenOfInvoice({ idempotency_key: 'renewal-1st:acct:2026' })).toBeNull()
    expect(offerTokenOfInvoice({ idempotency_key: null, tranche_offer_token: null })).toBeNull()
    expect(offerTokenOfInvoice({})).toBeNull()
    expect(offerTokenOfInvoice({ idempotency_key: 'offer-signed:' })).toBeNull()
    expect(offerTokenOfInvoice({ tranche_offer_token: '   ' })).toBeNull()
  })
})

describe('offerReferrerName — is this offer a referral, and by whom', () => {
  it('returns the typed name, trimmed', () => {
    expect(offerReferrerName({ referrer_name: '  Marco Rossi ' })).toBe('Marco Rossi')
  })

  it('is null when nobody referred the client', () => {
    expect(offerReferrerName({})).toBeNull()
    expect(offerReferrerName({ referrer_name: null, referrer_account_id: null, referrer_contact_id: null })).toBeNull()
    expect(offerReferrerName({ referrer_name: '   ' })).toBeNull()
  })

  it('an offer that only points at the referrer by id is still a referral (empty name)', () => {
    expect(offerReferrerName({ referrer_name: '', referrer_account_id: 'acct-1' })).toBe('')
    expect(offerReferrerName({ referrer_contact_id: 'contact-1' })).toBe('')
  })

  it('the typed name wins over the ids', () => {
    expect(offerReferrerName({ referrer_name: 'Marco', referrer_account_id: 'acct-1' })).toBe('Marco')
  })
})

describe('parseOfferSetupFee — the first section total on the offer', () => {
  it('reads the euro and dollar figures the offers actually carry', () => {
    expect(parseOfferSetupFee([{ label: 'Setup Fee', total: '€3,000' }])).toBe(3000)
    expect(parseOfferSetupFee([{ total: '€3,603' }])).toBe(3603)
    expect(parseOfferSetupFee([{ total: '$2,500' }])).toBe(2500)
    expect(parseOfferSetupFee([{ total: 2500 }])).toBe(2500)
  })

  it('only the FIRST section counts', () => {
    expect(parseOfferSetupFee([{ total: '€2,000' }, { total: '€9,999' }])).toBe(2000)
  })

  it('is 0 when there is nothing usable', () => {
    expect(parseOfferSetupFee(null)).toBe(0)
    expect(parseOfferSetupFee(undefined)).toBe(0)
    expect(parseOfferSetupFee('not an array')).toBe(0)
    expect(parseOfferSetupFee([])).toBe(0)
    expect(parseOfferSetupFee([{}])).toBe(0)
    expect(parseOfferSetupFee([{ total: '' }])).toBe(0)
    expect(parseOfferSetupFee([{ total: 'free' }])).toBe(0)
    expect(parseOfferSetupFee([{ total: '-€500' }])).toBe(0)
  })

  it('gives the same answers as the referrer credit parse in activate-service (so the tag and the credit never disagree)', () => {
    // The exact expression used at lib/operations/activate-service.ts Step 3.5, replicated here.
    const creditParse = (total: string): number => {
      let fee = Number(String(total).replace(/[€$,.\s]/g, (m) => (m === ',' ? '' : m === '.' ? '.' : ''))) || 0
      if (fee > 100000) fee = fee / 100
      return fee
    }
    for (const total of ['€3,000', '€2,500', '€3,603', '$1,250.50', '€2.500', ' €4 000 ', '€350000', '€0']) {
      expect(parseOfferSetupFee([{ total }])).toBe(creditParse(total))
    }
  })
})

describe('setupFeeFromSignedOffers — a company\'s setup fee', () => {
  it('uses the earliest signed offer that states a fee', () => {
    expect(
      setupFeeFromSignedOffers([
        { created_at: '2026-06-01T00:00:00Z', cost_summary: [{ total: '€1,000' }] },
        { created_at: '2026-01-01T00:00:00Z', cost_summary: [{ total: '€3,000' }] },
      ]),
    ).toBe(3000)
  })

  it('skips an earlier offer that states no fee', () => {
    expect(
      setupFeeFromSignedOffers([
        { created_at: '2026-01-01T00:00:00Z', cost_summary: [] },
        { created_at: '2026-02-01T00:00:00Z', cost_summary: [{ total: '€2,500' }] },
      ]),
    ).toBe(2500)
  })

  it('is 0 with no offers', () => {
    expect(setupFeeFromSignedOffers([])).toBe(0)
  })

  it('does not change the order of the list it was given', () => {
    const offers = [
      { created_at: '2026-06-01', cost_summary: [{ total: '€1' }] },
      { created_at: '2026-01-01', cost_summary: [{ total: '€2' }] },
    ]
    setupFeeFromSignedOffers(offers)
    expect(offers[0].created_at).toBe('2026-06-01')
  })
})

describe('SIGNED_OFFER_STATUSES', () => {
  it('is exactly the two statuses the signing flow accepts', () => {
    expect([...SIGNED_OFFER_STATUSES].sort()).toEqual(['completed', 'signed'])
  })
})
