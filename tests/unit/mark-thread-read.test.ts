import { describe, it, expect } from 'vitest'
import { buildStaffReplyReadPlan } from '@/lib/portal/mark-thread-read'

describe('buildStaffReplyReadPlan', () => {
  it('neither id → no work', () => {
    expect(
      buildStaffReplyReadPlan({ account_id: null, contact_id: null, linkedAccountIds: [], multiMemberAccountIds: [] }),
    ).toEqual([])
  })

  it('account thread → clears every client message on that account (solo)', () => {
    expect(
      buildStaffReplyReadPlan({ account_id: 'a1', contact_id: null, linkedAccountIds: [], multiMemberAccountIds: [] }),
    ).toEqual([{ kind: 'account', account_id: 'a1' }])
  })

  it('account thread wins even when a contact id rides along (multi-member reply) — fixes TITAN', () => {
    // Reply tagged with BOTH ids on a multi-member company must clear by account,
    // NOT fall into the contact branch that excludes multi-member accounts.
    expect(
      buildStaffReplyReadPlan({ account_id: 'a1', contact_id: 'c1', linkedAccountIds: ['a1'], multiMemberAccountIds: ['a1'] }),
    ).toEqual([{ kind: 'account', account_id: 'a1' }])
  })

  it('person thread, no linked accounts → just the contact-tagged rows', () => {
    expect(
      buildStaffReplyReadPlan({ account_id: null, contact_id: 'c1', linkedAccountIds: [], multiMemberAccountIds: [] }),
    ).toEqual([{ kind: 'contact_tagged', contact_id: 'c1', excludeAccountIds: [] }])
  })

  it('person thread, solo linked company → contact rows + company-only legacy rows', () => {
    expect(
      buildStaffReplyReadPlan({ account_id: null, contact_id: 'c1', linkedAccountIds: ['a1'], multiMemberAccountIds: [] }),
    ).toEqual([
      { kind: 'contact_tagged', contact_id: 'c1', excludeAccountIds: [] },
      { kind: 'company_only', accountIds: ['a1'] },
    ])
  })

  it('person thread, multi-member linked company → that account is excluded from both arms', () => {
    // a1 solo (company-only rows still cleared), a2 multi-member (excluded everywhere).
    expect(
      buildStaffReplyReadPlan({ account_id: null, contact_id: 'c1', linkedAccountIds: ['a1', 'a2'], multiMemberAccountIds: ['a2'] }),
    ).toEqual([
      { kind: 'contact_tagged', contact_id: 'c1', excludeAccountIds: ['a2'] },
      { kind: 'company_only', accountIds: ['a1'] },
    ])
  })

  it('person thread, all linked companies multi-member → no company-only arm, contact arm excludes them', () => {
    expect(
      buildStaffReplyReadPlan({ account_id: null, contact_id: 'c1', linkedAccountIds: ['a1'], multiMemberAccountIds: ['a1'] }),
    ).toEqual([{ kind: 'contact_tagged', contact_id: 'c1', excludeAccountIds: ['a1'] }])
  })
})
