/**
 * Grey double tick = "delivered" (dev job c1e326dd): the tick rules, what a device reports, and the server that stores it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { tickState, tickStateAll } from '@/lib/talk/chat-model'
import { deliveryItems } from '@/lib/talk/report-delivered'

const T0 = '2026-10-09T10:00:00.000Z'
const m = { created_at: '2026-10-09T10:00:05.000Z' }
const before = '2026-10-09T10:00:01.000Z'
const after = '2026-10-09T10:01:00.000Z'

describe('tick rules', () => {
  it('direct message: sent → delivered → seen', () => {
    expect(tickState(m, null, null)).toBe('sent')
    expect(tickState(m, before, before)).toBe('sent')
    expect(tickState(m, null, after)).toBe('delivered')
    expect(tickState(m, before, after)).toBe('delivered')
    expect(tickState(m, after, null)).toBe('seen') // reading implies delivered
    expect(tickState(m, after, after)).toBe('seen')
  })
  it('group: each level needs EVERY other member', () => {
    const others = ['a', 'b']
    expect(tickStateAll(m, [], {}, {})).toBe('sent')
    expect(tickStateAll(m, others, {}, { a: after })).toBe('sent') // only one has it
    expect(tickStateAll(m, others, {}, { a: after, b: after })).toBe('delivered')
    expect(tickStateAll(m, others, { a: after }, { b: after })).toBe('delivered') // a read (implies delivered), b delivered
    expect(tickStateAll(m, others, { a: after, b: after }, {})).toBe('seen')
    expect(tickStateAll(m, others, { a: after }, {})).toBe('sent') // b has nothing
  })
})

describe('what a device reports', () => {
  const th = (o: Record<string, unknown>) => ({ id: 't', thread_type: 'dm', unread_count: 1, last_message_at: T0, ...o })
  it('reports DMs and groups with something new, once per newest-message time', () => {
    expect(deliveryItems([th({})], {})).toEqual([{ thread_id: 't', as_of: T0 }])
    expect(deliveryItems([th({})], { t: T0 })).toEqual([])
    expect(deliveryItems([th({ last_message_at: after })], { t: T0 })).toEqual([{ thread_id: 't', as_of: after }])
    expect(deliveryItems([th({ thread_type: 'group' })], {}).length).toBe(1)
  })
  it('ignores channels, client conversations, nothing-new and empty chats', () => {
    expect(deliveryItems([th({ thread_type: 'channel' }), th({ thread_type: 'discussion', id: 'd' }), th({ id: 'e', unread_count: 0 }), th({ id: 'f', last_message_at: null })], {})).toEqual([])
  })
})

type Row = Record<string, unknown>
const h = vi.hoisted(() => ({ threads: [] as Row[], members: [] as string[], rpc: [] as Row[] }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/team/groups', () => ({ listGroupMemberIds: async () => h.members }))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ in: async (_c: string, ids: string[]) => ({ data: h.threads.filter(t => ids.includes(t.id as string)) }) }) }),
    rpc: async (_n: string, args: Row) => { h.rpc.push(args); return { error: null } },
  },
}))
import { markDelivered, normalizeDeliveryItems, MAX_DELIVERY_ITEMS } from '@/lib/team/delivery'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'
const DM = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const GR = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const CH = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const NOW = new Date('2026-10-09T12:00:00.000Z')

describe('normalizeDeliveryItems', () => {
  it('keeps good items, clamps the future to now, defaults a missing time to now, merges duplicates to the latest', () => {
    const out = normalizeDeliveryItems([
      { thread_id: DM, as_of: '2026-10-09T11:00:00.000Z' },
      { thread_id: DM, as_of: '2026-10-09T11:30:00.000Z' },
      { thread_id: GR, as_of: '2099-01-01T00:00:00.000Z' },
      { thread_id: CH },
      { thread_id: 'nope', as_of: '2026-10-09T11:00:00.000Z' },
      { thread_id: DM + 'x' }, { thread_id: U1, as_of: 'garbage' }, null, 5,
    ], NOW)
    expect(out).toEqual([
      { thread_id: DM, as_of: '2026-10-09T11:30:00.000Z' },
      { thread_id: GR, as_of: NOW.toISOString() },
      { thread_id: CH, as_of: NOW.toISOString() },
    ])
    expect(normalizeDeliveryItems('x', NOW)).toEqual([])
    expect(normalizeDeliveryItems(Array.from({ length: 200 }, (_, i) => ({ thread_id: `${String(i).padStart(8, '0')}-aaaa-aaaa-aaaa-aaaaaaaaaaaa` })), NOW).length).toBeLessThanOrEqual(MAX_DELIVERY_ITEMS)
  })
})

describe('markDelivered', () => {
  beforeEach(() => {
    h.rpc = []; h.members = [U1, 'other']
    h.threads = [
      { id: DM, thread_type: 'dm', dm_key: `${U1}:${U2}` },
      { id: GR, thread_type: 'group' },
      { id: CH, thread_type: 'channel' },
    ]
  })
  it("records only the caller's own DMs and groups they belong to", async () => {
    const n = await markDelivered(U1, [{ thread_id: DM }, { thread_id: GR }, { thread_id: CH }], NOW)
    expect(n).toBe(2)
    expect(h.rpc.map(r => r.p_thread_id).sort()).toEqual([DM, GR].sort())
    expect(h.rpc.every(r => r.p_user_id === U1)).toBe(true)
  })
  it("refuses someone else's DM and a group the caller is not in", async () => {
    h.members = ['other']
    expect(await markDelivered('99999999-9999-9999-9999-999999999999', [{ thread_id: DM }], NOW)).toBe(0)
    expect(await markDelivered(U1, [{ thread_id: GR }], NOW)).toBe(0)
    expect(h.rpc.length).toBe(0)
  })
})

describe('wiring guards', () => {
  const read = (p: string) => readFileSync(join(__dirname, '../../', p), 'utf8')
  it('both service workers ack a team-chat push, best-effort, from the thread in the notification address', () => {
    for (const f of ['public/talk-sw.js', 'public/dashboard-sw.js']) {
      const s = read(f)
      expect(s).toContain('ackDelivered')
      expect(s).toContain('/api/team/delivered')
      expect(s).toContain("credentials: 'same-origin'")
    }
  })
  it('TD Talk and the CRM page report delivery after loading the chat list; TD Talk renders the grey tick', () => {
    expect(read('components/talk/talk-app.tsx')).toContain('reportDelivered(d.threads')
    expect(read('app/(dashboard)/team-chat/page.tsx')).toContain('reportDelivered(d.threads)')
    expect(read('components/talk/talk-messages.tsx')).toContain('talk-tick-delivered')
  })
  it('the delivered route is staff-only', () => {
    const s = read('app/api/team/delivered/route.ts')
    expect(s).toContain('isDashboardUser')
    expect(s).toContain('markDelivered(user.id')
  })
})
