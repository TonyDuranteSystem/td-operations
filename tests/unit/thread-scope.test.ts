import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabaseAdmin: account_contacts.select('account_id, contact_id').in('account_id', [...])
// resolves to a configurable rows array.
let rows: { account_id: string; contact_id: string }[] = []
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        in: async () => ({ data: rows }),
      }),
    }),
  },
}))

import {
  contactThreadOrFilter,
  linkedContactIdsByAccount,
  bucketWhatsNewCounts,
  pickMultiMemberAccounts,
  multiMemberAccountIds,
} from '@/lib/portal/thread-scope'

describe('contactThreadOrFilter', () => {
  it('degrades to a plain contact match with no linked accounts', () => {
    expect(contactThreadOrFilter('c1', [])).toBe('contact_id.eq.c1')
  })

  it('includes company-only rows for the linked accounts', () => {
    expect(contactThreadOrFilter('c1', ['a1', 'a2'])).toBe(
      'contact_id.eq.c1,and(contact_id.is.null,account_id.in.(a1,a2))',
    )
  })

  it('empty exclusion list keeps the historical filter byte-identical', () => {
    expect(contactThreadOrFilter('c1', ['a1'], [])).toBe(
      contactThreadOrFilter('c1', ['a1']),
    )
  })

  it('excluded (multi-member) accounts are dropped from both arms', () => {
    // a1 = solo company (stays in company-only arm), a2 = multi-member (excluded)
    expect(contactThreadOrFilter('c1', ['a1', 'a2'], ['a2'])).toBe(
      'and(contact_id.eq.c1,or(account_id.is.null,account_id.not.in.(a2))),and(contact_id.is.null,account_id.in.(a1))',
    )
  })

  it('all linked accounts excluded → only the personal/non-excluded contact arm remains', () => {
    expect(contactThreadOrFilter('c1', ['a1'], ['a1'])).toBe(
      'and(contact_id.eq.c1,or(account_id.is.null,account_id.not.in.(a1)))',
    )
  })

  it('exclusion can name accounts outside the linked list (defensive)', () => {
    expect(contactThreadOrFilter('c1', [], ['a9'])).toBe(
      'and(contact_id.eq.c1,or(account_id.is.null,account_id.not.in.(a9)))',
    )
  })
})

describe('pickMultiMemberAccounts', () => {
  it('returns only accounts with 2+ distinct contacts', () => {
    expect(
      pickMultiMemberAccounts([
        { account_id: 'a1', contact_id: 'c1' },
        { account_id: 'a1', contact_id: 'c2' },
        { account_id: 'a2', contact_id: 'c1' },
      ]).sort(),
    ).toEqual(['a1'])
  })

  it('duplicate links to the same contact do not make an account multi-member', () => {
    expect(
      pickMultiMemberAccounts([
        { account_id: 'a1', contact_id: 'c1' },
        { account_id: 'a1', contact_id: 'c1' },
      ]),
    ).toEqual([])
  })

  it('ignores rows with missing ids and handles empty input', () => {
    expect(pickMultiMemberAccounts([])).toEqual([])
    expect(
      pickMultiMemberAccounts([
        { account_id: '', contact_id: 'c1' },
        { account_id: 'a1', contact_id: '' },
      ]),
    ).toEqual([])
  })
})

describe('multiMemberAccountIds', () => {
  beforeEach(() => {
    rows = []
  })

  it('short-circuits on empty input without querying', async () => {
    expect(await multiMemberAccountIds([])).toEqual([])
  })

  it('classifies via current account_contacts links', async () => {
    rows = [
      { account_id: 'a1', contact_id: 'c1' },
      { account_id: 'a1', contact_id: 'c2' },
      { account_id: 'a2', contact_id: 'c3' },
    ]
    expect(await multiMemberAccountIds(['a1', 'a2'])).toEqual(['a1'])
  })
})

describe('linkedContactIdsByAccount', () => {
  beforeEach(() => {
    rows = []
  })

  it('short-circuits on empty input without querying', async () => {
    const map = await linkedContactIdsByAccount([])
    expect(map.size).toBe(0)
  })

  it('groups contacts by account', async () => {
    rows = [
      { account_id: 'a1', contact_id: 'c1' },
      { account_id: 'a1', contact_id: 'c2' },
      { account_id: 'a2', contact_id: 'c3' },
    ]
    const map = await linkedContactIdsByAccount(['a1', 'a2'])
    expect(map.get('a1')).toEqual(['c1', 'c2'])
    expect(map.get('a2')).toEqual(['c3'])
  })
})

describe('bucketWhatsNewCounts', () => {
  const noLinks = new Map<string, string[]>()

  it('contact-only note counts in its contact bucket only', () => {
    const r = bucketWhatsNewCounts([{ account_id: null, contact_id: 'c1' }], noLinks)
    expect(r).toEqual({ by_account: {}, by_contact: { c1: 1 }, total: 1 })
  })

  it('both-tagged note counts for its account AND its tagged contact, not co-members', () => {
    const links = new Map([['a1', ['c1', 'c2']]])
    const r = bucketWhatsNewCounts([{ account_id: 'a1', contact_id: 'c1' }], links)
    expect(r.by_account).toEqual({ a1: 1 })
    expect(r.by_contact).toEqual({ c1: 1 }) // c2 must NOT be counted
    expect(r.total).toBe(1)
  })

  it('company-ONLY note fans out to every linked contact (superset person thread)', () => {
    const links = new Map([['a1', ['c1', 'c2']]])
    const r = bucketWhatsNewCounts([{ account_id: 'a1', contact_id: null }], links)
    expect(r.by_account).toEqual({ a1: 1 })
    expect(r.by_contact).toEqual({ c1: 1, c2: 1 })
    expect(r.total).toBe(1) // distinct note counted once globally
  })

  it('company-only note on an account with no linked contacts counts for the account only', () => {
    const r = bucketWhatsNewCounts([{ account_id: 'a1', contact_id: null }], noLinks)
    expect(r).toEqual({ by_account: { a1: 1 }, by_contact: {}, total: 1 })
  })

  it('a recipient-less note is ignored entirely', () => {
    const r = bucketWhatsNewCounts([{ account_id: null, contact_id: null }], noLinks)
    expect(r).toEqual({ by_account: {}, by_contact: {}, total: 0 })
  })

  it('mixed batch aggregates per bucket while total counts distinct notes', () => {
    const links = new Map([['a1', ['c1', 'c2']]])
    const r = bucketWhatsNewCounts(
      [
        { account_id: 'a1', contact_id: null },
        { account_id: 'a1', contact_id: 'c1' },
        { account_id: null, contact_id: 'c2' },
      ],
      links,
    )
    expect(r.by_account).toEqual({ a1: 2 })
    expect(r.by_contact).toEqual({ c1: 2, c2: 2 })
    expect(r.total).toBe(3)
  })

  // "One message, one staff thread" (2026-07-08): notes on a multi-member
  // account light ONLY the account thread's dot — never a contact bucket.
  it('both-tagged note on a MULTI-MEMBER account counts for the account only', () => {
    const links = new Map([['a1', ['c1', 'c2']]])
    const r = bucketWhatsNewCounts(
      [{ account_id: 'a1', contact_id: 'c1' }],
      links,
      new Set(['a1']),
    )
    expect(r.by_account).toEqual({ a1: 1 })
    expect(r.by_contact).toEqual({})
    expect(r.total).toBe(1)
  })

  it('company-only note on a MULTI-MEMBER account does not fan out to members', () => {
    const links = new Map([['a1', ['c1', 'c2']]])
    const r = bucketWhatsNewCounts(
      [{ account_id: 'a1', contact_id: null }],
      links,
      new Set(['a1']),
    )
    expect(r.by_account).toEqual({ a1: 1 })
    expect(r.by_contact).toEqual({})
    expect(r.total).toBe(1)
  })

  it('solo accounts keep the superset fan-out when a multi-member set is provided', () => {
    const links = new Map([['a1', ['c1']]])
    const r = bucketWhatsNewCounts(
      [
        { account_id: 'a1', contact_id: null },
        { account_id: null, contact_id: 'c1' },
      ],
      links,
      new Set(['other']),
    )
    expect(r.by_account).toEqual({ a1: 1 })
    expect(r.by_contact).toEqual({ c1: 2 })
    expect(r.total).toBe(2)
  })
})
