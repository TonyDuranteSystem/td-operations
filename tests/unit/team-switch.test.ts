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
function world(initial: SwitchRow | null, opts: { banFails?: boolean; strictLogFails?: boolean; bestLogFails?: boolean; markOffRace?: boolean; markOnRace?: boolean; takeOverRace?: boolean; restoreFails?: boolean; sharesFail?: boolean } = {}) {
  const state = {
    row: initial ? { ...initial } : null, banned: initial ? initial.status !== 'active' : false, events: [] as TeamEventInput[], order: [] as string[],
    /** each call to end the login's shares, with the steps that had already happened when it ran (kept apart from `order` so older order checks stay as they were) */
    sharesEnded: [] as Array<{ because: string; before: string[] }>,
  }
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
    takeOver: async (_i, _a, reason, at) => {
      state.order.push('takeOver')
      const r = state.row
      if (opts.takeOverRace || !r || r.status !== 'revoked' || r.switched_off_by !== 'owner') return false
      state.row = { ...r, switched_off_by: 'td', switched_off_reason: reason || null, switched_off_at: at }
      return true
    },
    restoreOff: async (row) => { state.order.push('restoreOff'); if (opts.restoreFails) throw new Error('db down'); state.row = { ...row } },
    setBan: async (_u, banned) => {
      state.order.push(banned ? 'ban' : 'unban')
      if (opts.banFails) throw new Error('auth down')
      state.banned = banned
    },
    endShares: async (_i, _a, _actor, because) => {
      if (opts.sharesFail) throw new Error('shares db down')
      state.sharesEnded.push({ because, before: [...state.order] })
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

describe('TD can lock someone an owner switched off', () => {
  it('takes over: the stamp now says TD, the reason is recorded, and the owner can no longer switch them on', async () => {
    const w = world(offBy('owner'))
    await switchOffTeammate('tm1', 'a1', td, 'investigation', w.deps)
    expect(w.state.row).toMatchObject({ status: 'revoked', switched_off_by: 'td', switched_off_reason: 'investigation' })
    expect(w.state.events[0]).toMatchObject({ event: 'switched_off', detail: { reason: 'investigation', took_over_from: 'owner' } })
    expect(await code(switchOnTeammate('tm1', 'a1', owner, w.deps))).toBe('td_locked')
    expect(await code(switchOnTeammate('tm1', 'a1', td, w.deps))).toBe('ok')
  })
  it('TD still needs a reason to take over', async () => {
    const w = world(offBy('owner'))
    expect(await code(switchOffTeammate('tm1', 'a1', td, ' ', w.deps))).toBe('reason_required')
    expect(w.state.row?.switched_off_by).toBe('owner')
  })
  it('an owner cannot "switch off" someone TD already switched off, and TD cannot do it twice', async () => {
    expect(await code(switchOffTeammate('tm1', 'a1', owner, '', world(offBy('td')).deps))).toBe('already_off')
    expect(await code(switchOffTeammate('tm1', 'a1', td, 'again', world(offBy('td')).deps))).toBe('already_off')
    expect(await code(switchOffTeammate('tm1', 'a1', owner, '', world(offBy('owner')).deps))).toBe('already_off')
  })
  it('a concurrent change while taking over is reported', async () => {
    expect(await code(switchOffTeammate('tm1', 'a1', td, 'x', world(offBy('owner'), { takeOverRace: true }).deps))).toBe('conflict')
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
    // blocks the sign-in FIRST, then puts the status back
    expect(w.state.order).toEqual(['unban', 'markOn', 'log-strict', 'ban', 'restoreOff'])
  })
  it('if even the put-back fails, the person is still BLOCKED and the message says so (never "all fine")', async () => {
    const w = world(offBy('owner'), { strictLogFails: true, restoreFails: true })
    let msg = ''
    try { await switchOnTeammate('tm1', 'a1', owner, w.deps) } catch (e) { msg = (e as Error).message }
    expect(msg).toMatch(/blocked from signing in/)
    expect(msg).toMatch(/contact support/)
    expect(w.state.banned).toBe(true)
  })
})

describe('personal-document shares end with the login (a share never outlives the stretch the login was continuously active)', () => {
  it('SWITCH OFF ends the login\'s shares after the login is already refused and blocked, and before the record', async () => {
    const { state, deps } = world(active)
    expect(await code(switchOffTeammate('tm1', 'a1', owner, '', deps))).toBe('ok')
    expect(state.sharesEnded).toEqual([{ because: 'switched_off', before: ['markOff', 'ban'] }])
  })
  it('a failure ending the shares never stops a switch-off (the person is already locked out) and is noted in the record', async () => {
    const { state, deps } = world(active, { sharesFail: true })
    expect(await code(switchOffTeammate('tm1', 'a1', owner, '', deps))).toBe('ok')
    expect(state.row?.status).toBe('revoked')
    expect(state.events[0]).toMatchObject({ event: 'switched_off', detail: { shares_end_failed: true } })
  })
  it('SWITCH ON ends any old shares FIRST — before the sign-in is unblocked or the status changes — so the login never comes back with one', async () => {
    const { state, deps } = world(offBy('owner'))
    expect(await code(switchOnTeammate('tm1', 'a1', owner, deps))).toBe('ok')
    expect(state.sharesEnded).toEqual([{ because: 'switched_on', before: [] }])
    expect(state.order.indexOf('unban')).toBeGreaterThan(-1)
  })
  it('if the old shares cannot be ended the person STAYS switched off and nothing else is touched', async () => {
    const { state, deps } = world(offBy('owner'), { sharesFail: true })
    expect(await code(switchOnTeammate('tm1', 'a1', owner, deps))).toBe('shares_failed')
    expect(state.row?.status).toBe('revoked')
    expect(state.banned).toBe(true)
    expect(state.order).toEqual([]) // no unban, no status change, no record
  })
  it('TD takeover of an owner\'s switch-off, a removed person and a "not off" person never touch shares', async () => {
    const a = world(offBy('owner')); await code(switchOffTeammate('tm1', 'a1', td, 'locking', a.deps)); expect(a.state.sharesEnded).toEqual([])
    const b = world(removed); await code(switchOnTeammate('tm1', 'a1', owner, b.deps)); expect(b.state.sharesEnded).toEqual([])
    const c = world(active); await code(switchOnTeammate('tm1', 'a1', owner, c.deps)); expect(c.state.sharesEnded).toEqual([])
  })
})
