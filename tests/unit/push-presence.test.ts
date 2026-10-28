/**
 * "Has the app" (lib/portal/push-presence.ts) — shared by the chat "unread message" nudge and the stage-change emails (Antonio 2026-10-28:
 * email only for a client who does not have the app installed with notifications on). The rule: skip the email only when the SAME PERSON the
 * email would go to has a device the push goes to. Bug-hunter finding (2026-10-28): for a company-only case "some device of the company exists"
 * (a teammate's, another member's) must NOT silence the one person who receives the company's email.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fx = vi.hoisted(() => ({
  /** devices: who each is stamped with (a person, a company, or both; a teammate's device has no person) */
  subs: [] as Array<{ contact_id?: string; account_id?: string }>,
  /** the company's linked contacts (account_contacts) */
  links: [] as Array<{ contact_id: string | null; contacts: { email: string | null } | null }>,
  companyEmail: null as string | null,
  queries: [] as Array<Record<string, string>>,
  fail: false,
  emailLookupThrows: false,
}))
vi.mock('@/lib/portal/queries', () => ({
  getCompanyEmail: async () => { if (fx.emailLookupThrows) throw new Error('boom'); return fx.companyEmail },
}))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'push_subscriptions') {
        const filters: Record<string, string> = {}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const b: any = {
          select: () => b,
          eq: (col: string, val: string) => { filters[col] = val; return b },
          then: (resolve: (v: unknown) => unknown) => {
            fx.queries.push({ ...filters })
            if (fx.fail) return resolve({ count: null, error: { message: 'boom' } })
            return resolve({ count: fx.subs.filter((d) => Object.entries(filters).every(([k, v]) => (d as Record<string, string | undefined>)[k] === v)).length, error: null })
          },
        }
        return b
      }
      if (table === 'account_contacts') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const b: any = { select: () => b, eq: () => Promise.resolve({ data: fx.links, error: null }) }
        return b
      }
      throw new Error(`unexpected table ${table}`)
    },
  },
}))

import { personHasPush, personHasCompanyPush, companyEmailRecipientContactId, stageNoticeRecipientHasApp, recipientHasPush } from '@/lib/portal/push-presence'

beforeEach(() => {
  fx.subs = []; fx.links = []; fx.companyEmail = null; fx.queries = []; fx.fail = false; fx.emailLookupThrows = false
})

describe('personHasPush / personHasCompanyPush', () => {
  it('a device stamped with the person counts, whichever company it is stamped with', async () => {
    fx.subs = [{ contact_id: 'c1', account_id: 'other' }]
    expect(await personHasPush('c1')).toBe(true)
    expect(await personHasPush('c2')).toBe(false)
  })
  it('no person -> false, nothing asked', async () => {
    expect(await personHasPush(null)).toBe(false)
    expect(await personHasCompanyPush(null, 'a1')).toBe(false)
    expect(await personHasCompanyPush('c1', null)).toBe(false)
    expect(fx.queries).toEqual([])
  })
  it('a company push reaches only devices stamped with THAT company', async () => {
    fx.subs = [{ contact_id: 'c1', account_id: 'a-other' }]
    expect(await personHasCompanyPush('c1', 'a1')).toBe(false)
    fx.subs = [{ contact_id: 'c1', account_id: 'a1' }]
    expect(await personHasCompanyPush('c1', 'a1')).toBe(true)
  })
  it('a teammate\'s device (company only, no person) is nobody\'s', async () => {
    fx.subs = [{ account_id: 'a1' }]
    expect(await personHasCompanyPush('c1', 'a1')).toBe(false)
    expect(await personHasPush('c1')).toBe(false)
  })
})

describe('companyEmailRecipientContactId — who the digest emails for a company-only notice', () => {
  it('the linked contact who owns the company email address (case and spaces do not matter)', async () => {
    fx.companyEmail = ' Owner@Example.com '
    fx.links = [
      { contact_id: 'c-member', contacts: { email: 'member@example.com' } },
      { contact_id: 'c-owner', contacts: { email: 'owner@example.com' } },
    ]
    expect(await companyEmailRecipientContactId('a1')).toBe('c-owner')
  })
  it('the address belongs to nobody linked (e.g. a shared office mailbox) -> null', async () => {
    fx.companyEmail = 'office@example.com'
    fx.links = [{ contact_id: 'c1', contacts: { email: 'owner@example.com' } }]
    expect(await companyEmailRecipientContactId('a1')).toBeNull()
  })
  it('no company email at all -> null', async () => {
    fx.companyEmail = null
    expect(await companyEmailRecipientContactId('a1')).toBeNull()
  })
})

describe('stageNoticeRecipientHasApp — is the stage-move email redundant?', () => {
  it('the case has a CONTACT: the digest emails that person -> their own device counts (whatever company it is stamped with)', async () => {
    fx.subs = [{ contact_id: 'c1', account_id: 'other' }]
    expect(await stageNoticeRecipientHasApp({ contactId: 'c1', accountId: 'a1' })).toBe(true)
  })
  it('the case has a contact: a company-level device or another person\'s device does NOT count', async () => {
    fx.subs = [{ account_id: 'a1' }, { contact_id: 'c-other', account_id: 'a1' }]
    expect(await stageNoticeRecipientHasApp({ contactId: 'c1', accountId: 'a1' })).toBe(false)
  })
  it('COMPANY-ONLY case: the person who owns the company email has a device stamped with the company -> true', async () => {
    fx.companyEmail = 'owner@example.com'
    fx.links = [{ contact_id: 'c-owner', contacts: { email: 'owner@example.com' } }, { contact_id: 'c-member', contacts: { email: 'member@example.com' } }]
    fx.subs = [{ contact_id: 'c-owner', account_id: 'a1' }]
    expect(await stageNoticeRecipientHasApp({ contactId: null, accountId: 'a1' })).toBe(true)
  })
  it('COMPANY-ONLY case: ANOTHER member has the app but the owner (who gets the email) does not -> false, the owner is emailed', async () => {
    fx.companyEmail = 'owner@example.com'
    fx.links = [{ contact_id: 'c-owner', contacts: { email: 'owner@example.com' } }, { contact_id: 'c-member', contacts: { email: 'member@example.com' } }]
    fx.subs = [{ contact_id: 'c-member', account_id: 'a1' }]
    expect(await stageNoticeRecipientHasApp({ contactId: null, accountId: 'a1' })).toBe(false)
  })
  it('COMPANY-ONLY case: only a teammate\'s device (no person) exists -> false', async () => {
    fx.companyEmail = 'owner@example.com'
    fx.links = [{ contact_id: 'c-owner', contacts: { email: 'owner@example.com' } }]
    fx.subs = [{ account_id: 'a1' }]
    expect(await stageNoticeRecipientHasApp({ contactId: null, accountId: 'a1' })).toBe(false)
  })
  it('COMPANY-ONLY case: the owner\'s device is stamped with a DIFFERENT company (the company push does not reach it) -> false', async () => {
    fx.companyEmail = 'owner@example.com'
    fx.links = [{ contact_id: 'c-owner', contacts: { email: 'owner@example.com' } }]
    fx.subs = [{ contact_id: 'c-owner', account_id: 'a-other' }]
    expect(await stageNoticeRecipientHasApp({ contactId: null, accountId: 'a1' })).toBe(false)
  })
  it('COMPANY-ONLY case: the company email belongs to nobody linked -> false', async () => {
    fx.companyEmail = 'office@example.com'
    fx.links = [{ contact_id: 'c1', contacts: { email: 'owner@example.com' } }]
    fx.subs = [{ contact_id: 'c1', account_id: 'a1' }]
    expect(await stageNoticeRecipientHasApp({ contactId: null, accountId: 'a1' })).toBe(false)
  })
  it('nobody addressed -> false', async () => {
    expect(await stageNoticeRecipientHasApp({})).toBe(false)
  })
  it('NEVER throws and fails toward emailing: a lookup error or a thrown error answers false', async () => {
    fx.fail = true
    expect(await stageNoticeRecipientHasApp({ contactId: 'c1' })).toBe(false)
    fx.fail = false
    fx.emailLookupThrows = true
    await expect(stageNoticeRecipientHasApp({ accountId: 'a1' })).resolves.toBe(false)
  })
})

describe('recipientHasPush — the chat "unread message" nudge rule (unchanged by the refactor)', () => {
  it('the person has a device -> true (and the company is not even asked)', async () => {
    fx.subs = [{ contact_id: 'c1' }]
    expect(await recipientHasPush({ contactId: 'c1', accountId: 'a1', singleRecipient: true })).toBe(true)
    expect(fx.queries).toEqual([{ contact_id: 'c1' }])
  })
  it('no device anywhere -> false (the email goes out)', async () => {
    expect(await recipientHasPush({ contactId: 'c1', accountId: 'a1', singleRecipient: true })).toBe(false)
  })
  it('a company-level device counts only when this is the ONE person to reach', async () => {
    fx.subs = [{ account_id: 'a1' }]
    expect(await recipientHasPush({ contactId: 'c1', accountId: 'a1', singleRecipient: true })).toBe(true)
    expect(await recipientHasPush({ contactId: 'c1', accountId: 'a1', singleRecipient: false })).toBe(false)
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
