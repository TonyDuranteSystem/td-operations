import { describe, it, expect } from 'vitest'
import { decideBacklogReferral, sameReferredIdentity, type BacklogReferralInput } from '@/lib/operations/referral'

const row = (over: Partial<BacklogReferralInput> = {}): BacklogReferralInput => ({
  id: 'r-1',
  referrer_contact_id: 'c-1',
  referrer_account_id: null,
  referred_contact_id: null,
  referred_account_id: null,
  referred_lead_id: null,
  referred_name: 'Mario Rossi',
  status: 'converted',
  commission_amount: 250,
  credited_amount: 0,
  ...over,
})

describe('sameReferredIdentity', () => {
  it('matches on referred_lead_id / contact_id / account_id', () => {
    expect(sameReferredIdentity(row({ referred_lead_id: 'l-1' }), row({ id: 'r-2', referred_lead_id: 'l-1', referred_name: 'Other' }))).toBe(true)
    expect(sameReferredIdentity(row({ referred_contact_id: 'x' }), row({ id: 'r-2', referred_contact_id: 'x', referred_name: 'Other' }))).toBe(true)
    expect(sameReferredIdentity(row({ referred_account_id: 'a' }), row({ id: 'r-2', referred_account_id: 'a', referred_name: 'Other' }))).toBe(true)
  })

  it('falls back to case-insensitive name match', () => {
    expect(sameReferredIdentity(row({ referred_name: ' mario ROSSI ' }), row({ id: 'r-2', referred_name: 'Mario Rossi' }))).toBe(true)
    expect(sameReferredIdentity(row({ referred_name: 'Mario Rossi' }), row({ id: 'r-2', referred_name: 'Luigi Verdi' }))).toBe(false)
  })

  it('never matches on empty names', () => {
    expect(sameReferredIdentity(row({ referred_name: null }), row({ id: 'r-2', referred_name: null }))).toBe(false)
    expect(sameReferredIdentity(row({ referred_name: '  ' }), row({ id: 'r-2', referred_name: '' }))).toBe(false)
  })
})

describe('decideBacklogReferral', () => {
  it('cancels a duplicate of an already-credited sibling (the Grifa double-pay case)', () => {
    // Same referrer, same referred lead — one row already credited: the backlog
    // row must be CANCELLED even though it would otherwise qualify for a credit.
    const backlogRow = row({ referred_lead_id: 'lead-1' })
    const creditedSibling = row({ id: 'r-credited', referred_lead_id: 'lead-1', status: 'credited', credited_amount: 500 })
    const d = decideBacklogReferral(backlogRow, { siblingReferrals: [creditedSibling], referrerAccountIds: ['acc-1'] })
    expect(d).toEqual({ action: 'cancel_duplicate', duplicateOfId: 'r-credited' })
  })

  it('does NOT treat a pending/converted sibling as a duplicate', () => {
    const backlogRow = row({ referred_lead_id: 'lead-1' })
    const pendingSibling = row({ id: 'r-2', referred_lead_id: 'lead-1', status: 'pending' })
    const d = decideBacklogReferral(backlogRow, { siblingReferrals: [pendingSibling], referrerAccountIds: ['acc-1'] })
    expect(d.action).toBe('credit')
  })

  it('credits when the referrer resolves to exactly one account and amount is positive', () => {
    const d = decideBacklogReferral(row(), { siblingReferrals: [], referrerAccountIds: ['acc-1'] })
    expect(d).toEqual({ action: 'credit', accountId: 'acc-1', amount: 250 })
  })

  it('uses the row account when account-keyed', () => {
    const d = decideBacklogReferral(row({ referrer_account_id: 'acc-9' }), { siblingReferrals: [], referrerAccountIds: ['acc-9'] })
    expect(d).toEqual({ action: 'credit', accountId: 'acc-9', amount: 250 })
  })

  it('skips with multiple_accounts when the person owns several companies (Adam Mihaly case)', () => {
    const d = decideBacklogReferral(row(), { siblingReferrals: [], referrerAccountIds: ['acc-1', 'acc-2'] })
    expect(d).toEqual({ action: 'skip', reason: 'multiple_accounts', accountIds: ['acc-1', 'acc-2'] })
  })

  it('skips with no_account when the referrer has no company (Marco Boschi case)', () => {
    const d = decideBacklogReferral(row(), { siblingReferrals: [], referrerAccountIds: [] })
    expect(d).toEqual({ action: 'skip', reason: 'no_account' })
  })

  it('skips with no_amount when commission is missing/zero (Nakal case)', () => {
    expect(decideBacklogReferral(row({ commission_amount: null }), { siblingReferrals: [], referrerAccountIds: ['acc-1'] }))
      .toEqual({ action: 'skip', reason: 'no_amount' })
    expect(decideBacklogReferral(row({ commission_amount: 0 }), { siblingReferrals: [], referrerAccountIds: ['acc-1'] }))
      .toEqual({ action: 'skip', reason: 'no_amount' })
  })

  it('skips with no_referrer when the row has no referrer at all', () => {
    const d = decideBacklogReferral(row({ referrer_contact_id: null, referrer_account_id: null }), { siblingReferrals: [], referrerAccountIds: [] })
    expect(d).toEqual({ action: 'skip', reason: 'no_referrer' })
  })

  it('duplicate check wins over credit eligibility', () => {
    // Eligible for credit AND duplicate → must cancel, never credit.
    const backlogRow = row({ referred_name: 'Davide Priori' })
    const credited = row({ id: 'r-paid', referred_name: 'davide priori', status: 'paid', paid_amount: 500 } as never)
    const d = decideBacklogReferral(backlogRow, { siblingReferrals: [credited], referrerAccountIds: ['acc-1'] })
    expect(d.action).toBe('cancel_duplicate')
  })

  it('deduplicates the account candidate list', () => {
    const d = decideBacklogReferral(row(), { siblingReferrals: [], referrerAccountIds: ['acc-1', 'acc-1'] })
    expect(d).toEqual({ action: 'credit', accountId: 'acc-1', amount: 250 })
  })
})
