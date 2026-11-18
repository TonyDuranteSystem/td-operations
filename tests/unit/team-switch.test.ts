import { describe, it, expect } from 'vitest'
import {
  isSwitchedOff,
  cleanReason,
  switchOffTeammate,
  switchOnTeammate,
  TeamSwitchError,
  type SwitchDeps,
  type SwitchRow,
} from '@/lib/portal/team/switch'
import type { TeamEventInput } from '@/lib/portal/team/events'

const owner = { kind: 'owner' as const, contactId: 'c1' }
const td = { kind: 'td' as const, staffEmail: 'antonio.durante@tonydurante.us' }

const active: SwitchRow = { id: 'tm1', account_id: 'a1', auth_user_id: 'u1', status: 'active', switched_off_at: null, switched_off_by: null, switched_off_reason: null }
const offBy = (by: 'owner' | 'td'): SwitchRow => ({ ...active, status: 'revoked', switched_off_at: '2026-11-17T10:00:00.000Z', switched_off_by: by, switched_off_reason: 'because' })
const removed: SwitchRow = { ...active, status: 'revoked' }

/** In-memory fake of the database + login, with switches to make each step fail. */
function world(initial: SwitchRow | null, opts: { banFails?: boolean; strictLogFails?: boolean; bestLogFails?: boolean; markOffRace?: boolean; markOnRace?: boolean } = {}) {
  const state = { row: initial ? { ...initial } : null, banned: initial ? initial.status !== 'active' : false, events: [] as TeamEventInput[], order: [] as string[] }
  const deps: SwitchDeps = {
    getRow: async () => (state.row ? { ...state.row } : null),
    markOff: async (_i, _a, by, reason, at) => {
      state.order.push('markOff')
      if (opts.markOffRace || !state.row || state.row.status !== 'active') return false
      state.row = { ...state.row, status: 'revoked', switched_off_at: at, switched_off_by: by, switched_off_reason: reason || null }
      return true
    },
    markOn: async (_i, _a, actorKind) => {
      state.order.push('markOn')
      const r = state.row
      if (opts.markOnRace || !r || r.status !== 'revoked' || !r.switched_off_at) return false
      if (actorKind === 'owner' && r.switched_off_by !== 'owner') return false
      state.row = { ...r, status: 'active', switched_off_at: null, switched_off_by: null, switched_off_reason: null }
      return true
    },
    restoreOff: async (row) => { state.order.push('restoreOff'); state.row = { ...row } },
    setBan: async (_u, banned) => {
      state.order.push(banned ? 'ban' : 'unban')
      if (opts.banFails) throw new Error('auth down')
      state.banned = banned
    },
    record: {
      strict: async (e) => { state.order.push('log-strict'); if (opts.strictLogFails) throw new Error('log down'); state.events.push(e) },
      bestEffort: async (e) => { state.order.push('log-best'); if (opts.bestLogFails) return false; state.events.push(e); return true },
    },
    now: () => new Date('2026-11-17T12:00:00.000Z'),
  }
  return { state, deps }
}
const code = async (p: Promise<unknown>) => { try { await p; return 'ok' } catch (e) { return e instanceof TeamSwitchError ? e.code : 'other:' + String(e) } }

describe('isSwitchedOff / cleanReason', () => {
  it('only revoked-with-a-stamp is "switched off"', () => {
    expect(isSwitchedOff(active)).toBe(false)
    expect(isSwitchedOff(offBy('owner'))).toBe(true)
    expect(isSwitchedOff(removed)).toBe(false)
  })
  it('trims and caps the reason, ignores non-text', () => {
    expect(cleanReason('  gone  ')).toBe('gone')
    expect(cleanReason('x'.repeat(900))).toHaveLength(500)
    expect(cleanReason(undefined)).toBe('')
    expect(cleanReason(5)).toBe('')
  })
})

describe('switchOffTeammate', () => {
  it('an owner switches someone off: status first, then the ban, then the record; reason optional', async () => {
    const w = world(active)
    await switchOffTeammate('tm1', 'a1', owner, '', w.deps)
    expect(w.state.row).toMatchObject({ status: 'revoked', switched_off_by: 'owner', switched_off_at: '2026-11-17T12:00:00.000Z', switched_off_reason: null })
    expect(w.state.banned).toBe(true)
    expect(w.state.order).toEqual(['markOff', 'ban', 'log-best'])
    expect(w.state.events[0]).toMatchObject({ event: 'switched_off', actor: owner })
  })
  it('TD must give a reason, and it is recorded', async () => {
    const w = world(active)
    expect(await code(switchOffTeammate('tm1', 'a1', td, '  ', w.deps))).toBe('reason_required')
    expect(w.state.row?.status).toBe('active')
    await switchOffTeammate('tm1', 'a1', td, 'client asked', w.deps)
    expect(w.state.row).toMatchObject({ switched_off_by: 'td', switched_off_reason: 'client asked' })
    expect(w.state.events[0].detail).toMatchObject({ reason: 'client asked' })
  })
  it('refuses an unknown person, someone already off, someone removed for good', async () => {
    expect(await code(switchOffTeammate('tm1', 'a1', owner, '', world(null).deps))).toBe('not_found')
    expect(await code(switchOffTeammate('tm1', 'a1', owner, '', world(offBy('owner')).deps))).toBe('already_off')
    expect(await code(switchOffTeammate('tm1', 'a1', owner, '', world(removed).deps))).toBe('removed')
  })
  it('refuses a "system" actor and a conflict with a concurrent change', async () => {
    expect(await code(switchOffTeammate('tm1', 'a1', { kind: 'system' }, '', world(active).deps))).toBe('conflict')
    expect(await code(switchOffTeammate('tm1', 'a1', owner, '', world(active, { markOffRace: true }).deps))).toBe('conflict')
  })
  it('a failing ban still leaves the person OFF (fail closed) and says so', async () => {
    const w = world(active, { banFails: true })
    expect(await code(switchOffTeammate('tm1', 'a1', owner, '', w.deps))).toBe('ban_failed')
    expect(w.state.row?.status).toBe('revoked')
    expect(w.state.events[0].detail).toMatchObject({ ban_failed: true })
  })
  it('a failing record never stops a switch-off', async () => {
    const w = world(active, { bestLogFails: true })
    expect(await code(switchOffTeammate('tm1', 'a1', owner, '', w.deps))).toBe('ok')
    expect(w.state.row?.status).toBe('revoked')
  })
})

describe('switchOnTeammate', () => {
  it('an owner switches back on someone THEY switched off: unban, status, strict record', async () => {
    const w = world(offBy('owner'))
    await switchOnTeammate('tm1', 'a1', owner, w.deps)
    expect(w.state.row).toMatchObject({ status: 'active', switched_off_at: null, switched_off_by: null, switched_off_reason: null })
    expect(w.state.banned).toBe(false)
    expect(w.state.order).toEqual(['unban', 'markOn', 'log-strict'])
    expect(w.state.events[0]).toMatchObject({ event: 'switched_on', detail: { previously_switched_off_by: 'owner' } })
  })
  it('an owner can NOT undo a switch-off made by TD (nothing is touched)', async () => {
    const w = world(offBy('td'))
    expect(await code(switchOnTeammate('tm1', 'a1', owner, w.deps))).toBe('td_locked')
    expect(w.state.order).toEqual([])
    expect(w.state.row?.status).toBe('revoked')
  })
  it('TD can undo either its own or an owner\'s switch-off', async () => {
    for (const by of ['td', 'owner'] as const) {
      const w = world(offBy(by))
      expect(await code(switchOnTeammate('tm1', 'a1', td, w.deps))).toBe('ok')
      expect(w.state.row?.status).toBe('active')
    }
  })
  it('a person REMOVED for good can never be switched on; an active person is "not off"', async () => {
    expect(await code(switchOnTeammate('tm1', 'a1', owner, world(removed).deps))).toBe('removed')
    expect(await code(switchOnTeammate('tm1', 'a1', td, world(removed).deps))).toBe('removed')
    expect(await code(switchOnTeammate('tm1', 'a1', owner, world(active).deps))).toBe('not_off')
    expect(await code(switchOnTeammate('tm1', 'a1', owner, world(null).deps))).toBe('not_found')
  })
  it('if the ban cannot be lifted nothing else happens', async () => {
    const w = world(offBy('owner'), { banFails: true })
    expect(await code(switchOnTeammate('tm1', 'a1', owner, w.deps))).toBe('ban_failed')
    expect(w.state.row?.status).toBe('revoked')
    expect(w.state.order).toEqual(['unban'])
  })
  it('a concurrent change after the unban puts the ban back', async () => {
    const w = world(offBy('owner'), { markOnRace: true })
    expect(await code(switchOnTeammate('tm1', 'a1', owner, w.deps))).toBe('conflict')
    expect(w.state.banned).toBe(true)
    expect(w.state.row?.status).toBe('revoked')
  })
  it('NO RECORD, NO GRANT: when the record cannot be saved the person is put back OFF exactly as before', async () => {
    const before = offBy('owner')
    const w = world(before, { strictLogFails: true })
    expect(await code(switchOnTeammate('tm1', 'a1', owner, w.deps))).toBe('log_failed')
    expect(w.state.row).toEqual(before)
    expect(w.state.banned).toBe(true)
    expect(w.state.order).toEqual(['unban', 'markOn', 'log-strict', 'restoreOff', 'ban'])
  })
})
