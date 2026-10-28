/**
 * "Has the app" — the one rule (lib/portal/push-presence.ts) shared by the chat "unread message" nudge and the stage-change emails
 * (Antonio 2026-10-28: email only for a client who does not have the app installed with notifications on).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fx = vi.hoisted(() => ({
  contactSubs: [] as string[],
  accountSubs: [] as string[],
  queries: [] as Array<[string, string]>,
  fail: false,
}))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== 'push_subscriptions') throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          eq: async (col: string, val: string) => {
            fx.queries.push([col, val])
            if (fx.fail) return { count: null, error: { message: 'boom' } }
            return { count: (col === 'contact_id' ? fx.contactSubs : fx.accountSubs).includes(val) ? 1 : 0, error: null }
          },
        }),
      }
    },
  },
}))

import { recipientHasPush } from '@/lib/portal/push-presence'

beforeEach(() => { fx.contactSubs = []; fx.accountSubs = []; fx.queries = []; fx.fail = false })

describe('recipientHasPush', () => {
  it('the person has a subscription -> true (and the company is not even asked)', async () => {
    fx.contactSubs = ['c1']
    expect(await recipientHasPush({ contactId: 'c1', accountId: 'a1', singleRecipient: true })).toBe(true)
    expect(fx.queries).toEqual([['contact_id', 'c1']])
  })
  it('no subscription anywhere -> false (the email goes out)', async () => {
    expect(await recipientHasPush({ contactId: 'c1', accountId: 'a1', singleRecipient: true })).toBe(false)
  })
  it('a company-level subscription counts only when this is the ONE person to reach', async () => {
    fx.accountSubs = ['a1']
    expect(await recipientHasPush({ contactId: 'c1', accountId: 'a1', singleRecipient: true })).toBe(true)
    expect(await recipientHasPush({ contactId: 'c1', accountId: 'a1', singleRecipient: false })).toBe(false)
  })
  it('a company-only notice (no person) checks the company subscription', async () => {
    fx.accountSubs = ['a1']
    expect(await recipientHasPush({ contactId: null, accountId: 'a1', singleRecipient: true })).toBe(true)
  })
  it('no person and no company -> false, nothing asked', async () => {
    expect(await recipientHasPush({ contactId: null, accountId: null, singleRecipient: true })).toBe(false)
    expect(fx.queries).toEqual([])
  })
  it('a lookup error counts as "no app": the client is emailed rather than silenced', async () => {
    fx.fail = true
    expect(await recipientHasPush({ contactId: 'c1', accountId: 'a1', singleRecipient: true })).toBe(false)
  })
})
