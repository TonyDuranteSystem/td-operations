import { describe, it, expect } from 'vitest'
import { accountIdForOffer } from '@/lib/operations/offer-scope'

const ACCT = '1e23b37f-6a09-4ebf-bcf6-328176121c50'

describe('accountIdForOffer', () => {
  it('strips account_id for an explicit formation offer', () => {
    expect(accountIdForOffer('formation', ACCT)).toBeNull()
  })

  it('strips account_id when contract_type is missing (defaults to formation)', () => {
    expect(accountIdForOffer(undefined, ACCT)).toBeNull()
    expect(accountIdForOffer(null, ACCT)).toBeNull()
    expect(accountIdForOffer('', ACCT)).toBeNull()
  })

  it('keeps account_id for non-formation contract types', () => {
    expect(accountIdForOffer('renewal', ACCT)).toBe(ACCT)
    expect(accountIdForOffer('onboarding', ACCT)).toBe(ACCT)
    expect(accountIdForOffer('tax_return', ACCT)).toBe(ACCT)
    expect(accountIdForOffer('itin', ACCT)).toBe(ACCT)
    expect(accountIdForOffer('closure', ACCT)).toBe(ACCT)
  })

  it('returns null when no account given, regardless of type', () => {
    expect(accountIdForOffer('formation', null)).toBeNull()
    expect(accountIdForOffer('formation', undefined)).toBeNull()
    expect(accountIdForOffer('renewal', null)).toBeNull()
    expect(accountIdForOffer('renewal', undefined)).toBeNull()
  })
})
