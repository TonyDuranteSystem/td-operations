import { describe, it, expect } from 'vitest'
import {
  bucketUnreadEmails,
  extractEmailAddress,
} from '@/lib/inbox/email-unread'

const rows = [
  { contact_id: 'c1', account_id: 'a1', email: 'mario@x.com', email_2: null },
  { contact_id: 'c1', account_id: 'a2', email: 'mario@x.com', email_2: null }, // same person, 2nd LLC
  { contact_id: 'c2', account_id: 'a3', email: 'luigi@y.com', email_2: 'luigi2@y.com' },
  { contact_id: 'c3', account_id: null, email: 'lead@z.com', email_2: null }, // contact without account
]

describe('extractEmailAddress', () => {
  it('parses "Name <email>" and bare addresses, lowercased', () => {
    expect(extractEmailAddress('Mario Rossi <Mario@X.com>')).toBe('mario@x.com')
    expect(extractEmailAddress('  LUIGI@Y.COM ')).toBe('luigi@y.com')
  })
})

describe('bucketUnreadEmails', () => {
  it('counts one unread thread for contact and every linked account', () => {
    const buckets = bucketUnreadEmails([new Set(['mario@x.com'])], rows)
    expect(buckets.by_contact).toEqual({ c1: 1 })
    expect(buckets.by_account).toEqual({ a1: 1, a2: 1 })
  })

  it('matches secondary emails and accountless contacts', () => {
    const buckets = bucketUnreadEmails(
      [new Set(['luigi2@y.com']), new Set(['lead@z.com'])],
      rows
    )
    expect(buckets.by_contact).toEqual({ c2: 1, c3: 1 })
    expect(buckets.by_account).toEqual({ a3: 1 })
  })

  it('a thread counts at most once per client even with both their emails on it', () => {
    const buckets = bucketUnreadEmails(
      [new Set(['luigi@y.com', 'luigi2@y.com'])],
      rows
    )
    expect(buckets.by_contact).toEqual({ c2: 1 })
    expect(buckets.by_account).toEqual({ a3: 1 })
  })

  it('non-client senders produce no buckets', () => {
    const buckets = bucketUnreadEmails([new Set(['stripe@notifications.com'])], rows)
    expect(buckets.by_contact).toEqual({})
    expect(buckets.by_account).toEqual({})
  })

  it('accumulates across multiple unread threads', () => {
    const buckets = bucketUnreadEmails(
      [new Set(['mario@x.com']), new Set(['mario@x.com'])],
      rows
    )
    expect(buckets.by_contact).toEqual({ c1: 2 })
    expect(buckets.by_account).toEqual({ a1: 2, a2: 2 })
  })
})
