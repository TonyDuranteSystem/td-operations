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
})
