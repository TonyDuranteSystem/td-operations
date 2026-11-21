/** Waiting-for-client reminder sweep (lib/portal/waiting-reminders) — 2026-11-21. Database and notifier are faked. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = { id: string; account_id: string | null; contact_id: string | null; marked_at: string; reminders_sent: number; last_reminder_at: string | null }

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  clientMsgs: [] as { created_at: string }[],
  account: { status: 'Active', is_test: false } as { status: string; is_test: boolean } | null,
  updates: [] as { id: string; patch: Record<string, unknown> }[],
  notify: vi.fn(),
}))

vi.mock('@/lib/portal/action-required', () => ({ notifyClientActionRequired: (...a: unknown[]) => state.notify(...a) }))
vi.mock('@/lib/supabase-admin', () => {
  const chain = (table: string) => {
    const q: Record<string, unknown> = {}
    const self = () => q
    for (const m of ['select', 'order', 'eq', 'is', 'gte', 'limit', 'update']) q[m] = (...args: unknown[]) => {
      if (m === 'update') (q as { _patch?: unknown })._patch = args[0]
      if (m === 'eq' && (q as { _patch?: unknown })._patch) {
        state.updates.push({ id: String(args[1]), patch: (q as { _patch: Record<string, unknown> })._patch })
        return Promise.resolve({ error: null })
      }
      return self()
    }
    q.maybeSingle = () => Promise.resolve({ data: table === 'accounts' ? state.account : null })
    q.then = (res: (v: unknown) => unknown) => {
      if (table === 'portal_chat_waiting_threads') return Promise.resolve({ data: state.rows, error: null }).then(res)
      if (table === 'portal_messages') return Promise.resolve({ data: state.clientMsgs, error: null }).then(res)
      return Promise.resolve({ data: [], error: null }).then(res)
    }
    return q
  }
  return { supabaseAdmin: { from: (t: string) => chain(t) } }
})

import { runWaitingReminderSweep } from '@/lib/portal/waiting-reminders'

const NOW = new Date('2026-11-21T13:00:00Z')
const row = (over: Partial<Row> = {}): Row => ({ id: 'w1', account_id: 'acc-1', contact_id: null, marked_at: '2026-11-17T13:00:00Z', reminders_sent: 0, last_reminder_at: null, ...over })

beforeEach(() => {
  state.rows = []
  state.clientMsgs = []
  state.account = { status: 'Active', is_test: false }
  state.updates = []
  state.notify.mockReset()
  state.notify.mockResolvedValue({ dispatched: true, chat: 'ok', notification: 'ok', email: 'ok (1 sent)' })
})

describe('runWaitingReminderSweep', () => {
  it('reminds a client who has been silent 3+ days and records it', async () => {
    state.rows = [row()]
    const r = await runWaitingReminderSweep(NOW)
    expect(r).toMatchObject({ scanned: 1, dispatched: 1, skipped: 0, unreachable: 0, errors: [] })
    expect(state.notify).toHaveBeenCalledTimes(1)
    expect(state.notify.mock.calls[0][0]).toMatchObject({ account_id: 'acc-1', bellType: 'chat' })
    expect(state.updates).toEqual([{ id: 'w1', patch: { reminders_sent: 1, last_reminder_at: NOW.toISOString() } }])
  })

  it('only reads "waiting for client" marks — a "waiting on us" mark never reminds the client', async () => {
    const eqCalls: unknown[][] = []
    state.rows = []
    const { supabaseAdmin } = await import('@/lib/supabase-admin')
    const realFrom = supabaseAdmin.from.bind(supabaseAdmin)
    const spy = vi.spyOn(supabaseAdmin, 'from').mockImplementation(((t: string) => {
      const q = realFrom(t) as unknown as Record<string, (...a: unknown[]) => unknown>
      const origEq = q.eq
      q.eq = (...a: unknown[]) => { eqCalls.push(a); return origEq(...a) }
      return q
    }) as never)
    await runWaitingReminderSweep(NOW)
    spy.mockRestore()
    expect(eqCalls).toContainEqual(['kind', 'client'])
  })

  it('does nothing before the 3 days are up', async () => {
    state.rows = [row({ marked_at: '2026-11-20T13:00:00Z' })]
    const r = await runWaitingReminderSweep(NOW)
    expect(r.dispatched).toBe(0)
    expect(r.skipped).toBe(1)
    expect(state.notify).not.toHaveBeenCalled()
  })

  it('does nothing once the client has written after the mark', async () => {
    state.rows = [row()]
    state.clientMsgs = [{ created_at: '2026-11-19T10:00:00Z' }]
    const r = await runWaitingReminderSweep(NOW)
    expect(r.dispatched).toBe(0)
    expect(state.notify).not.toHaveBeenCalled()
  })

  it('stops after the maximum number of reminders', async () => {
    state.rows = [row({ reminders_sent: 2, last_reminder_at: '2026-11-10T13:00:00Z' })]
    const r = await runWaitingReminderSweep(NOW)
    expect(r.dispatched).toBe(0)
    expect(state.notify).not.toHaveBeenCalled()
  })

  it('never mails a test company', async () => {
    state.rows = [row()]
    state.account = { status: 'Active', is_test: true }
    const r = await runWaitingReminderSweep(NOW)
    expect(r.dispatched).toBe(0)
    expect(state.notify).not.toHaveBeenCalled()
  })

  it('counts a company the portal hides as unreachable and does not mark it reminded', async () => {
    state.rows = [row()]
    state.account = { status: 'Closed', is_test: false }
    const r = await runWaitingReminderSweep(NOW)
    expect(r.unreachable).toBe(1)
    expect(r.dispatched).toBe(0)
    expect(state.updates).toEqual([])
  })

  it('when nothing at all went out, counts unreachable and tries again next run', async () => {
    state.rows = [row()]
    state.notify.mockResolvedValue({ dispatched: true, chat: 'failed: x', notification: 'failed: y', email: 'skipped: no recipient email' })
    const r = await runWaitingReminderSweep(NOW)
    expect(r.unreachable).toBe(1)
    expect(r.dispatched).toBe(0)
    expect(state.updates).toEqual([])
  })

  it('a duplicate-notice guard hit is a skip, not a failure', async () => {
    state.rows = [row()]
    state.notify.mockResolvedValue({ dispatched: false, chat: 'skipped: duplicate within dedup window', notification: 'skipped: duplicate within dedup window', email: 'skipped: duplicate within dedup window' })
    const r = await runWaitingReminderSweep(NOW)
    expect(r.skipped).toBe(1)
    expect(r.unreachable).toBe(0)
  })

  it('a reminder that reached the portal but sent no email is still recorded, and flagged unreachable for staff', async () => {
    state.rows = [row()]
    state.notify.mockResolvedValue({ dispatched: true, chat: 'ok', notification: 'ok', email: 'skipped: no recipient email' })
    const r = await runWaitingReminderSweep(NOW)
    expect(r.dispatched).toBe(1)
    expect(r.unreachable).toBe(1)
    expect(state.updates).toHaveLength(1)
  })

  it('a person-level conversation reminds that person', async () => {
    state.rows = [row({ account_id: null, contact_id: 'con-1' })]
    await runWaitingReminderSweep(NOW)
    expect(state.notify.mock.calls[0][0]).toMatchObject({ account_id: null, contact_id: 'con-1' })
  })
})
