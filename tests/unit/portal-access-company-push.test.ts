/**
 * A company's phone alert never reaches a person whose link to the company carries the "no portal access" mark, even when the
 * subscription was made while they still had access (dev job beb43385, QA 21 Nov 2026).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  subs: [] as Array<{ id: string; endpoint: string; p256dh: string; auth_key: string; contact_id: string | null; user_id?: string }>,
  marked: new Set<string>(),
  sent: [] as string[],
  /** this company's team logins (portal_team_members) */
  logins: [] as Array<{ auth_user_id: string; status: string; capabilities: unknown }>,
  loginsFail: false,
}))

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async (sub: { endpoint: string }) => { h.sent.push(sub.endpoint) }),
  },
}))
vi.mock('@/lib/members/marked-on-company', () => ({
  markedContactIds: vi.fn(async () => h.marked),
  isMarkedOnCompany: vi.fn(async () => false),
}))
vi.mock('@/lib/portal-app/client-phone-leg', () => ({ startClientPhoneLeg: () => null }))
vi.mock('@/lib/app/phone-leg', () => ({ startPhoneLeg: () => null, waitForPhoneLeg: async () => {} }))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => ({
        eq: () => Promise.resolve(
          table === 'portal_team_members'
            ? (h.loginsFail ? { data: null, error: { message: 'boom' } } : { data: h.logins, error: null })
            : { data: h.subs, error: null },
        ),
      }),
      delete: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
    }),
  },
}))

import { sendPushToAccount } from '@/lib/portal/web-push'

const sub = (id: string, contact_id: string | null, user_id?: string) => ({ id, endpoint: `https://push.example/${id}`, p256dh: 'p', auth_key: 'a', contact_id, ...(user_id ? { user_id } : {}) })
const payload = { title: 't', body: 'b' }

beforeEach(() => {
  h.subs = []
  h.marked = new Set()
  h.sent = []
  h.logins = []
  h.loginsFail = false
  process.env.VAPID_PUBLIC_KEY = 'pub'
  process.env.VAPID_PRIVATE_KEY = 'priv'
})

describe('sendPushToAccount and the no-portal-access mark', () => {
  it('leaves out the phones of marked people, keeps everyone else', async () => {
    h.subs = [sub('open', 'c-open'), sub('marked', 'c-marked'), sub('nobody', null)]
    h.marked = new Set(['c-marked'])
    const r = await sendPushToAccount('acc', payload)
    expect(h.sent.sort()).toEqual(['https://push.example/nobody', 'https://push.example/open'])
    expect(r).toEqual({ sent: 2, failed: 0 })
  })

  it('sends nothing when every phone belongs to a marked person', async () => {
    h.subs = [sub('m1', 'c-1'), sub('m2', 'c-2')]
    h.marked = new Set(['c-1', 'c-2'])
    const r = await sendPushToAccount('acc', payload)
    expect(h.sent).toEqual([])
    expect(r).toEqual({ sent: 0, failed: 0 })
  })

  it('a company with nobody marked behaves exactly as before', async () => {
    h.subs = [sub('a', 'c-a'), sub('b', 'c-b')]
    const r = await sendPushToAccount('acc', payload)
    expect(h.sent.sort()).toEqual(['https://push.example/a', 'https://push.example/b'])
    expect(r).toEqual({ sent: 2, failed: 0 })
  })
})

describe('sendPushToAccount and team logins (dev job e59dd470)', () => {
  it('a team login that is ACTIVE with the chat tick still gets the company alert', async () => {
    h.subs = [sub('client', 'c-1', 'client-user'), sub('team', null, 'team-user')]
    h.logins = [{ auth_user_id: 'team-user', status: 'active', capabilities: { chat: true } }]
    await sendPushToAccount('acc', payload)
    expect(h.sent.sort()).toEqual(['https://push.example/client', 'https://push.example/team'])
  })
  it('a REMOVED or switched-off login\'s device gets nothing (its row is still there)', async () => {
    h.subs = [sub('client', 'c-1', 'client-user'), sub('gone', null, 'gone-user')]
    h.logins = [{ auth_user_id: 'gone-user', status: 'revoked', capabilities: { chat: true } }]
    const r = await sendPushToAccount('acc', payload)
    expect(h.sent).toEqual(['https://push.example/client'])
    expect(r).toEqual({ sent: 1, failed: 0 })
  })
  it('a login that lost the chat tick gets nothing either (the alert is a chat alert)', async () => {
    h.subs = [sub('nochat', null, 'nochat-user')]
    h.logins = [{ auth_user_id: 'nochat-user', status: 'active', capabilities: { documents: true } }]
    expect(await sendPushToAccount('acc', payload)).toEqual({ sent: 0, failed: 0 })
    expect(h.sent).toEqual([])
  })
  it('a device with no sign-in id (legacy company row) is unchanged', async () => {
    h.subs = [sub('legacy', null)]
    h.logins = [{ auth_user_id: 'gone-user', status: 'revoked', capabilities: { chat: true } }]
    await sendPushToAccount('acc', payload)
    expect(h.sent).toEqual(['https://push.example/legacy'])
  })
  it('when the logins cannot be read, only devices that belong to a person are sent to (an unknown device is not trusted)', async () => {
    h.subs = [sub('client', 'c-1', 'client-user'), sub('unknown', null, 'maybe-gone-user')]
    h.loginsFail = true
    await sendPushToAccount('acc', payload)
    expect(h.sent).toEqual(['https://push.example/client'])
  })
})
