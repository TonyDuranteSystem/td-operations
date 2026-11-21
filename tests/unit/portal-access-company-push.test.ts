/**
 * A company's phone alert never reaches a person whose link to the company carries the "no portal access" mark, even when the
 * subscription was made while they still had access (dev job beb43385, QA 21 Nov 2026).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  subs: [] as Array<{ id: string; endpoint: string; p256dh: string; auth_key: string; contact_id: string | null }>,
  marked: new Set<string>(),
  sent: [] as string[],
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
    from: () => ({
      select: () => ({ eq: () => Promise.resolve({ data: h.subs, error: null }) }),
      delete: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
    }),
  },
}))

import { sendPushToAccount } from '@/lib/portal/web-push'

const sub = (id: string, contact_id: string | null) => ({ id, endpoint: `https://push.example/${id}`, p256dh: 'p', auth_key: 'a', contact_id })
const payload = { title: 't', body: 'b' }

beforeEach(() => {
  h.subs = []
  h.marked = new Set()
  h.sent = []
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
