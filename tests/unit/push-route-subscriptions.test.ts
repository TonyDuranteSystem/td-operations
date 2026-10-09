/**
 * Which installed app a staff push goes to (dev job c1e326dd, TD Talk).
 * The rule is pure (lib/push/route-subscriptions.ts); the second half drives it through the real sender.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { routeAdminSubscriptions, normalizeApp, TALK_APP } from '@/lib/push/route-subscriptions'

const crm = (id: string, user: string) => ({ id, user_id: user, app: null })
const talk = (id: string, user: string) => ({ id, user_id: user, app: TALK_APP })
const ids = (subs: Array<{ id: string }>) => subs.map(s => s.id)

describe('routeAdminSubscriptions', () => {
  const subs = [crm('luca-crm', 'luca'), talk('luca-talk', 'luca'), crm('antonio-crm', 'antonio'), talk('cris-talk', 'cris')]

  it('a direct message goes to TD Talk INSTEAD of the CRM app for a person who has TD Talk (no double buzz)', () => {
    expect(ids(routeAdminSubscriptions(subs, true))).toEqual(['luca-talk', 'antonio-crm', 'cris-talk'])
  })
  it('a direct message still reaches the CRM app of a person with no TD Talk', () => {
    expect(ids(routeAdminSubscriptions([crm('a', 'antonio')], true))).toEqual(['a'])
  })
  it('anything that is not a direct message never reaches TD Talk', () => {
    expect(ids(routeAdminSubscriptions(subs, false))).toEqual(['luca-crm', 'antonio-crm'])
  })
  it('a person with ONLY TD Talk gets nothing for a channel post or a system alert', () => {
    expect(routeAdminSubscriptions([talk('x', 'cris')], false)).toEqual([])
  })
  it('keeps several devices of one app (phone + laptop) and several TD Talk installs', () => {
    const many = [crm('p1', 'u'), crm('p2', 'u'), talk('t1', 'u'), talk('t2', 'u')]
    expect(ids(routeAdminSubscriptions(many, true))).toEqual(['t1', 't2'])
    expect(ids(routeAdminSubscriptions(many, false))).toEqual(['p1', 'p2'])
  })
  it('treats a row with no app information (before the column existed) as the CRM app', () => {
    const legacy = [{ id: 'old', user_id: 'u' }, { id: 'old2', user_id: 'v', app: undefined }]
    expect(ids(routeAdminSubscriptions(legacy, true))).toEqual(['old', 'old2'])
    expect(ids(routeAdminSubscriptions(legacy, false))).toEqual(['old', 'old2'])
  })
  it('an empty list stays empty', () => {
    expect(routeAdminSubscriptions([], true)).toEqual([])
  })
})

describe('normalizeApp', () => {
  it('stores only the known app name; anything else means the CRM app', () => {
    expect(normalizeApp('talk')).toBe('talk')
    for (const bad of ['Talk', 'portal', '', null, undefined, 5, { a: 1 }, ['talk']]) expect(normalizeApp(bad)).toBeNull()
  })
})

// ─── through the real sender ────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  sent: [] as Array<{ endpoint: string; payload: Record<string, unknown> }>,
  subs: [] as Array<Record<string, unknown>>,
}))

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async (sub: { endpoint: string }, payload: string) => {
      h.sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) })
    }),
  },
}))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ in: () => Promise.resolve({ data: h.subs, error: null }) }),
      delete: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
    }),
  },
}))

describe('sendPushToAdminUsers routes by app', () => {
  beforeEach(() => {
    h.sent.length = 0
    process.env.VAPID_PUBLIC_KEY = 'pub'
    process.env.VAPID_PRIVATE_KEY = 'priv'
    h.subs = [
      { id: '1', user_id: 'luca', app: null, endpoint: 'https://push/luca-crm', p256dh: 'p', auth_key: 'a' },
      { id: '2', user_id: 'luca', app: 'talk', endpoint: 'https://push/luca-talk', p256dh: 'p', auth_key: 'a' },
    ]
  })

  it('a direct message buzzes TD Talk only, and the "dm" hint never reaches the phone', async () => {
    const { sendPushToAdminUsers } = await import('@/lib/portal/web-push')
    const r = await sendPushToAdminUsers(['luca'], { title: 'Antonio', body: 'hi', url: '/team-chat?thread=t1', tag: 'dm', dm: true })
    expect(r).toEqual({ sent: 1, failed: 0 })
    expect(h.sent.map(s => s.endpoint)).toEqual(['https://push/luca-talk'])
    expect(h.sent[0].payload).toEqual({ title: 'Antonio', body: 'hi', url: '/team-chat?thread=t1', tag: 'dm' })
    expect('dm' in h.sent[0].payload).toBe(false)
  })
  it('a channel post buzzes the CRM app only', async () => {
    const { sendPushToAdminUsers } = await import('@/lib/portal/web-push')
    await sendPushToAdminUsers(['luca'], { title: 'Antonio · #td-bug', body: 'x' })
    expect(h.sent.map(s => s.endpoint)).toEqual(['https://push/luca-crm'])
  })
  it('sends nothing when the only subscription is TD Talk and it is not a direct message', async () => {
    h.subs = [h.subs[1]]
    const { sendPushToAdminUsers } = await import('@/lib/portal/web-push')
    expect(await sendPushToAdminUsers(['luca'], { title: 't', body: 'b' })).toEqual({ sent: 0, failed: 0 })
    expect(h.sent).toEqual([])
  })
})
