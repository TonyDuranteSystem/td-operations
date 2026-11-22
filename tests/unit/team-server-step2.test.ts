import { describe, it, expect, vi, beforeEach } from 'vitest'

// A tiny scripted fake of the database + login client: each .from(table) chain records what was done and answers from `script`.
const { state } = vi.hoisted(() => ({
  state: {
    ops: [] as Array<{ table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> }>,
    answers: {} as Record<string, unknown>,
    authUser: null as null | { app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> },
    authUpdates: [] as Array<{ id: string; attrs: Record<string, unknown> }>,
    authUpdateError: null as null | { message: string },
  },
}))

function chain(table: string, op: string, payload?: unknown) {
  const rec = { table, op, payload, filters: [] as Array<[string, unknown]> }
  state.ops.push(rec)
  const key = `${table}:${op}`
  const result = () => (key in state.answers ? state.answers[key] : { data: null, error: null })
  const c: Record<string, unknown> = {}
  const self = () => c
  for (const m of ['select', 'not', 'is', 'in', 'order', 'limit']) c[m] = self
  c.eq = (col: string, v: unknown) => { rec.filters.push([col, v]); return c }
  c.maybeSingle = async () => result()
  c.single = async () => result()
  c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej)
  return c
}

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => chain(table, 'select'),
      insert: (p: unknown) => chain(table, 'insert', p),
      update: (p: unknown) => chain(table, 'update', p),
      delete: () => chain(table, 'delete'),
    }),
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: state.authUser }, error: null }),
        updateUserById: async (id: string, attrs: Record<string, unknown>) => { state.authUpdates.push({ id, attrs }); return { error: state.authUpdateError } },
        deleteUser: async () => ({ error: null }),
        createUser: async () => ({ data: { user: { id: 'u-new' } }, error: null }),
      },
    },
  },
}))
const { enqueueNotices } = vi.hoisted(() => ({ enqueueNotices: vi.fn() }))
vi.mock('@/lib/portal/team/notify', () => ({ enqueueTeamNotices: enqueueNotices }))
vi.mock('@/lib/portal/resolve-portal-identity', () => ({ resolvePortalIdentity: vi.fn() }))
vi.mock('@/lib/portal/team/account-admin', () => ({ isAccountAdmin: vi.fn() }))

import { resetTeammatePassword, updateTeammate, revokeTeammate, switchTeammateOff, switchTeammateOn, ConfirmationRequiredError, listTeammates, teammateState } from '@/lib/portal/team/server'

const owner = { kind: 'owner' as const, contactId: 'c1', ip: '1.1.1.1' }
const confirm = { version: 'v1-draft', text: 'the words the owner read', ip: '1.1.1.1' }
const td = { kind: 'td' as const, staffEmail: 'antonio.durante@tonydurante.us' }
const teamAuth = { app_metadata: { role: 'client', kind: 'team_member', account_id: 'a1' }, user_metadata: { x: 1 } }
const eventsWritten = () => state.ops.filter(o => o.table === 'portal_team_events' && o.op === 'insert').map(o => (o.payload as { event: string }).event)

beforeEach(() => {
  state.ops = []
  state.answers = {}
  state.authUser = teamAuth
  state.authUpdates = []
  state.authUpdateError = null
  enqueueNotices.mockReset()
  enqueueNotices.mockResolvedValue(2)
})

describe('resetTeammatePassword', () => {
  it('resets a real team login and records it', async () => {
    state.answers['portal_team_members:select'] = { data: { auth_user_id: 'u1', username: 'mario', status: 'active' }, error: null }
    const r = await resetTeammatePassword('tm1', 'a1', owner)
    expect(r.username).toBe('mario')
    expect(r.password.length).toBeGreaterThan(8)
    expect(state.authUpdates[0].attrs.user_metadata).toMatchObject({ must_change_password: true, x: 1 })
    // server-enforced: the flag goes into app metadata too, keeping what was already there
    expect(state.authUpdates[0].attrs.app_metadata).toMatchObject({ role: 'client', kind: 'team_member', must_change_password: true })
    expect(eventsWritten()).toEqual(['password_reset'])
  })
  it('REFUSES a login that is not a team login (a real client\'s password can never be reset here)', async () => {
    state.answers['portal_team_members:select'] = { data: { auth_user_id: 'u1', username: 'mario', status: 'active' }, error: null }
    for (const meta of [{ role: 'client', contact_id: 'c9' }, { role: 'client', kind: 'team_member', contact_id: 'c9' }, { role: 'team', kind: 'team_member' }, {}]) {
      state.authUser = { app_metadata: meta, user_metadata: {} }
      await expect(resetTeammatePassword('tm1', 'a1', owner)).rejects.toThrow(/not a team login/)
    }
    expect(state.authUpdates).toEqual([])
  })
  it('refuses someone removed or switched off, and an unknown person', async () => {
    state.answers['portal_team_members:select'] = { data: { auth_user_id: 'u1', username: 'mario', status: 'revoked' }, error: null }
    await expect(resetTeammatePassword('tm1', 'a1', owner)).rejects.toThrow(/removed or switched off/)
    state.answers['portal_team_members:select'] = { data: null, error: null }
    await expect(resetTeammatePassword('tm1', 'a1', owner)).rejects.toThrow(/not found/)
  })
})

describe('updateTeammate', () => {
  const before = (caps: unknown, status = 'active') => { state.answers['portal_team_members:select'] = { data: { capabilities: caps, status }, error: null } }
  it('records a change of powers; only while the person is active', async () => {
    before({ chat: true, documents: true })
    state.answers['portal_team_members:update'] = { data: [{ id: 'tm1' }], error: null }
    await updateTeammate('tm1', 'a1', { capabilities: { chat: true } }, owner)
    expect(eventsWritten()).toEqual(['powers_changed'])
    const upd = state.ops.find(o => o.table === 'portal_team_members' && o.op === 'update')!
    expect(upd.filters).toContainEqual(['status', 'active'])
  })
  it('NO RECORD, NO GRANT: adding a power with a failing record puts the old powers back', async () => {
    before({ chat: true })
    state.answers['portal_team_members:update'] = { data: [{ id: 'tm1' }], error: null }
    state.answers['portal_team_events:insert'] = { data: null, error: { message: 'down' } }
    await expect(updateTeammate('tm1', 'a1', { capabilities: { chat: true, documents: true } }, owner, confirm)).rejects.toThrow(/powers were not changed/)
    const updates = state.ops.filter(o => o.table === 'portal_team_members' && o.op === 'update')
    expect((updates[updates.length - 1].payload as { capabilities: unknown }).capabilities).toEqual({ chat: true })
  })
  it('the put-back is conditional on nobody having edited the person since, and says so when it could not happen', async () => {
    before({ chat: true })
    const answers = state.answers as Record<string, unknown>
    let n = 0
    Object.defineProperty(answers, 'portal_team_members:update', { get: () => (++n === 1 ? { data: [{ id: 'tm1' }], error: null } : { data: [], error: null }), configurable: true })
    state.answers['portal_team_events:insert'] = { data: null, error: { message: 'down' } }
    await expect(updateTeammate('tm1', 'a1', { capabilities: { chat: true, documents: true } }, owner, confirm)).rejects.toThrow(/could not put the old powers back/)
    const updates = state.ops.filter(o => o.table === 'portal_team_members' && o.op === 'update')
    expect(updates[1].filters.some(([c]) => c === 'updated_at')).toBe(true)
    expect(updates[1].filters.find(([c]) => c === 'updated_at')![1]).toBe((updates[0].payload as { updated_at: string }).updated_at)
  })
  it('a put-back that fails with a database error is also reported, never swallowed', async () => {
    before({ chat: true })
    let n = 0
    Object.defineProperty(state.answers as Record<string, unknown>, 'portal_team_members:update', { get: () => (++n === 1 ? { data: [{ id: 'tm1' }], error: null } : { data: null, error: { message: 'db down' } }), configurable: true })
    state.answers['portal_team_events:insert'] = { data: null, error: { message: 'down' } }
    await expect(updateTeammate('tm1', 'a1', { capabilities: { chat: true, documents: true } }, owner, confirm)).rejects.toThrow(/could not put the old powers back/)
  })
  it('removing a power never fails because of the record', async () => {
    before({ chat: true, documents: true })
    state.answers['portal_team_members:update'] = { data: [{ id: 'tm1' }], error: null }
    state.answers['portal_team_events:insert'] = { data: null, error: { message: 'down' } }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(updateTeammate('tm1', 'a1', { capabilities: { chat: true } }, owner)).resolves.toEqual({ ok: true })
    spy.mockRestore()
  })
  it('refuses a switched-off person and a concurrent change; a rename alone writes no record', async () => {
    before({ chat: true }, 'revoked')
    await expect(updateTeammate('tm1', 'a1', { capabilities: {} }, owner)).rejects.toThrow(/switched off or removed/)
    before({ chat: true })
    state.answers['portal_team_members:update'] = { data: [], error: null }
    await expect(updateTeammate('tm1', 'a1', { display_name: 'X Y' }, owner)).rejects.toThrow(/changed by someone else/)
    state.answers['portal_team_members:update'] = { data: [{ id: 'tm1' }], error: null }
    state.ops = []
    await updateTeammate('tm1', 'a1', { display_name: 'X Y' }, owner)
    expect(eventsWritten()).toEqual([])
  })
})

describe('revokeTeammate (remove for good)', () => {
  it('marks revoked, clears any switch-off stamp, bans the login, records it', async () => {
    state.answers['portal_team_members:select'] = { data: { auth_user_id: 'u1' }, error: null }
    await revokeTeammate('tm1', 'a1', owner)
    const upd = state.ops.find(o => o.table === 'portal_team_members' && o.op === 'update')!
    expect(upd.payload).toMatchObject({ status: 'revoked', switched_off_at: null, switched_off_by: null, switched_off_reason: null })
    expect(state.authUpdates[0]).toEqual({ id: 'u1', attrs: { ban_duration: '876000h' } })
    expect(eventsWritten()).toEqual(['removed'])
  })
  it('still removes when the database does not have the new columns yet (code before the database change)', async () => {
    state.answers['portal_team_members:select'] = { data: { auth_user_id: 'u1' }, error: null }
    let n = 0
    const original = state.answers
    Object.defineProperty(state.answers, 'portal_team_members:update', { get: () => (++n === 1 ? { data: null, error: { code: '42703', message: 'column "switched_off_at" does not exist' } } : { data: null, error: null }), configurable: true })
    await expect(revokeTeammate('tm1', 'a1', owner)).resolves.toEqual({ ok: true })
    const updates = state.ops.filter(o => o.table === 'portal_team_members' && o.op === 'update')
    expect(updates).toHaveLength(2)
    expect(updates[1].payload).toMatchObject({ status: 'revoked' })
    expect(updates[1].payload).not.toHaveProperty('switched_off_at')
    expect(state.authUpdates).toHaveLength(1)
    expect(original).toBe(state.answers)
  })
})

describe('revokeTeammate: personal-document shares end with the person', () => {
  const sharesDeleted = () => state.ops.filter(o => o.table === 'portal_team_document_shares' && o.op === 'delete')
  it('deletes the person\'s shares and leaves a "Stopped sharing" line for each owner, then the removal line', async () => {
    state.answers['portal_team_members:select'] = { data: { auth_user_id: 'u1' }, error: null }
    state.answers['portal_team_document_shares:delete'] = { data: [{ owner_contact_id: 'c1' }, { owner_contact_id: 'c2' }], error: null }
    await revokeTeammate('tm1', 'a1', owner)
    expect(sharesDeleted()).toHaveLength(1)
    expect(sharesDeleted()[0].filters).toContainEqual(['team_member_id', 'tm1'])
    const lines = state.ops.filter(o => o.table === 'portal_team_events' && o.op === 'insert').map(o => o.payload as { event: string; detail?: Record<string, unknown> })
    expect(lines.map(l => l.event)).toEqual(['powers_changed', 'powers_changed', 'removed'])
    expect(lines[0].detail).toMatchObject({ personal_documents: false, owner_contact_id: 'c1', ended_because: 'removed' })
    expect(lines[1].detail).toMatchObject({ personal_documents: false, owner_contact_id: 'c2', ended_because: 'removed' })
  })
  it('a failure deleting the shares never fails the removal (the login is already refused); it is noted on the removal line', async () => {
    state.answers['portal_team_members:select'] = { data: { auth_user_id: 'u1' }, error: null }
    state.answers['portal_team_document_shares:delete'] = { data: null, error: { message: 'db down' } }
    await expect(revokeTeammate('tm1', 'a1', owner)).resolves.toEqual({ ok: true })
    const removed = state.ops.find(o => o.table === 'portal_team_events' && o.op === 'insert')!
    expect(removed.payload).toMatchObject({ event: 'removed', detail: { shares_end_failed: true } })
  })
})

describe('revokeTeammate: the login\'s alert devices are deleted too', () => {
  const devicesDeleted = () => state.ops.filter(o => o.table === 'push_subscriptions' && o.op === 'delete')
  it('deletes the devices registered by this login\'s sign-in id', async () => {
    state.answers['portal_team_members:select'] = { data: { auth_user_id: 'u1' }, error: null }
    await revokeTeammate('tm1', 'a1', owner)
    expect(devicesDeleted()).toHaveLength(1)
    expect(devicesDeleted()[0].filters).toContainEqual(['user_id', 'u1'])
  })
  it('a failure deleting them never fails the removal; it is noted on the removal line', async () => {
    state.answers['portal_team_members:select'] = { data: { auth_user_id: 'u1' }, error: null }
    state.answers['push_subscriptions:delete'] = { data: null, error: { message: 'db down' } }
    await expect(revokeTeammate('tm1', 'a1', owner)).resolves.toEqual({ ok: true })
    const removed = state.ops.find(o => o.table === 'portal_team_events' && o.op === 'insert')!
    expect(removed.payload).toMatchObject({ event: 'removed', detail: { devices_end_failed: true } })
  })
})

describe('revokeTeammate: a failed sign-in block is reported', () => {
  it('says so (and records it) instead of claiming everything is fine', async () => {
    state.answers['portal_team_members:select'] = { data: { auth_user_id: 'u1' }, error: null }
    state.authUpdateError = { message: 'auth down' }
    await expect(revokeTeammate('tm1', 'a1', owner)).rejects.toThrow(/could not be fully blocked/)
    const ev = state.ops.find(o => o.table === 'portal_team_events' && o.op === 'insert')!
    expect(ev.payload).toMatchObject({ event: 'removed', detail: { ban_failed: true } })
  })
})

describe('switch off / on through the real wiring', () => {
  it('TD can take over an owner\'s switch-off (the real update is limited to rows an owner switched off)', async () => {
    state.answers['portal_team_members:select'] = { data: { id: 'tm1', account_id: 'a1', auth_user_id: 'u1', status: 'revoked', switched_off_at: '2026-11-17T10:00:00Z', switched_off_by: 'owner', switched_off_reason: null }, error: null }
    state.answers['portal_team_members:update'] = { data: [{ id: 'tm1' }], error: null }
    await switchTeammateOff('tm1', 'a1', td, 'client asked us')
    const upd = state.ops.find(o => o.op === 'update')!
    expect(upd.payload).toMatchObject({ switched_off_by: 'td', switched_off_reason: 'client asked us' })
    expect(upd.filters).toContainEqual(['switched_off_by', 'owner'])
    expect(eventsWritten()).toEqual(['switched_off'])
  })
  it('a failing put-back (database error) is reported by the real wiring, not swallowed', async () => {
    state.answers['portal_team_members:select'] = { data: { id: 'tm1', account_id: 'a1', auth_user_id: 'u1', status: 'revoked', switched_off_at: '2026-11-17T10:00:00Z', switched_off_by: 'owner', switched_off_reason: null }, error: null }
    let n = 0
    Object.defineProperty(state.answers as Record<string, unknown>, 'portal_team_members:update', { get: () => (++n === 1 ? { data: [{ id: 'tm1' }], error: null } : { data: null, error: { message: 'db down' } }), configurable: true })
    state.answers['portal_team_events:insert'] = { data: null, error: { message: 'log down' } }
    await expect(switchTeammateOn('tm1', 'a1', owner)).rejects.toThrow(/blocked from signing in/)
  })
  it('an owner switches off: conditional on active, then bans, then records', async () => {
    state.answers['portal_team_members:select'] = { data: { id: 'tm1', account_id: 'a1', auth_user_id: 'u1', status: 'active', switched_off_at: null, switched_off_by: null, switched_off_reason: null }, error: null }
    state.answers['portal_team_members:update'] = { data: [{ id: 'tm1' }], error: null }
    await switchTeammateOff('tm1', 'a1', owner, 'left the company')
    const upd = state.ops.find(o => o.op === 'update')!
    expect(upd.payload).toMatchObject({ status: 'revoked', switched_off_by: 'owner', switched_off_reason: 'left the company' })
    expect(upd.filters).toContainEqual(['status', 'active'])
    expect(state.authUpdates[0].attrs).toEqual({ ban_duration: '876000h' })
    expect(eventsWritten()).toEqual(['switched_off'])
  })
  it('an owner cannot switch on what TD switched off; TD can, and the ban is lifted', async () => {
    state.answers['portal_team_members:select'] = { data: { id: 'tm1', account_id: 'a1', auth_user_id: 'u1', status: 'revoked', switched_off_at: '2026-11-17T10:00:00Z', switched_off_by: 'td', switched_off_reason: 'x' }, error: null }
    await expect(switchTeammateOn('tm1', 'a1', owner)).rejects.toThrow(/Tony Durante LLC switched this person off/)
    expect(state.authUpdates).toEqual([])
    state.answers['portal_team_members:update'] = { data: [{ id: 'tm1' }], error: null }
    await switchTeammateOn('tm1', 'a1', td)
    expect(state.authUpdates[0].attrs).toEqual({ ban_duration: 'none' })
    expect(eventsWritten()).toEqual(['switched_on'])
  })
  it('the database update for an owner is limited to switch-offs made by an owner', async () => {
    state.answers['portal_team_members:select'] = { data: { id: 'tm1', account_id: 'a1', auth_user_id: 'u1', status: 'revoked', switched_off_at: '2026-11-17T10:00:00Z', switched_off_by: 'owner', switched_off_reason: null }, error: null }
    state.answers['portal_team_members:update'] = { data: [{ id: 'tm1' }], error: null }
    await switchTeammateOn('tm1', 'a1', owner)
    const upd = state.ops.find(o => o.op === 'update')!
    expect(upd.filters).toContainEqual(['switched_off_by', 'owner'])
    expect(upd.filters).toContainEqual(['status', 'revoked'])
  })
})

describe('step 4: giving MORE power needs the owner\'s confirmation, and everyone is told', () => {
  const before = (caps: unknown, extra: Record<string, unknown> = {}) => {
    state.answers['portal_team_members:select'] = { data: { capabilities: caps, status: 'active', notice_version: 'v0', notice_accepted_at: '2026-11-01T00:00:00Z', notice_accepted_ip: '9.9.9.9', ...extra }, error: null }
    state.answers['portal_team_members:update'] = { data: [{ id: 'tm1' }], error: null }
  }
  const updates = () => state.ops.filter(o => o.table === 'portal_team_members' && o.op === 'update')

  it('refuses to add a power without the confirmation — before touching anything', async () => {
    before({ chat: true })
    await expect(updateTeammate('tm1', 'a1', { capabilities: { chat: true, documents: true } }, owner)).rejects.toBeInstanceOf(ConfirmationRequiredError)
    expect(updates()).toHaveLength(0)
    expect(eventsWritten()).toEqual([])
    expect(enqueueNotices).not.toHaveBeenCalled()
  })
  it('with the confirmation: saves the new notice, records the exact words, and tells the owners and members', async () => {
    before({ chat: true })
    await updateTeammate('tm1', 'a1', { capabilities: { chat: true, documents: true, answer_decisions: true } }, owner, confirm)
    expect(updates()[0].payload).toMatchObject({ notice_version: 'v1-draft', notice_accepted_ip: '1.1.1.1' })
    const ev = state.ops.find(o => o.table === 'portal_team_events' && o.op === 'insert')!
    expect(ev.payload).toMatchObject({ event: 'powers_changed', detail: { notice_version: 'v1-draft', notice_text: 'the words the owner read' } })
    expect(enqueueNotices).toHaveBeenCalledTimes(1)
    expect(enqueueNotices.mock.calls[0][0]).toMatchObject({ accountId: 'a1', teamMemberId: 'tm1', kind: 'more', actorContactId: 'c1', addedKeys: ['documents', 'answer_decisions'] })
  })
  it('NO ONE TOLD, NO GRANT: if nobody can be told the powers and the notice go back as they were', async () => {
    before({ chat: true })
    enqueueNotices.mockRejectedValue(new Error('nobody could be told'))
    await expect(updateTeammate('tm1', 'a1', { capabilities: { chat: true, documents: true } }, owner, confirm)).rejects.toThrow(/powers were not changed/)
    const last = updates()[updates().length - 1].payload as Record<string, unknown>
    expect(last).toMatchObject({ capabilities: { chat: true }, notice_version: 'v0', notice_accepted_ip: '9.9.9.9' })
  })
  it('taking a power away, or only renaming, needs no confirmation and tells nobody', async () => {
    before({ chat: true, documents: true })
    await updateTeammate('tm1', 'a1', { capabilities: { chat: true } }, owner)
    await updateTeammate('tm1', 'a1', { display_name: 'New Name' }, owner)
    expect(enqueueNotices).not.toHaveBeenCalled()
    expect(updates()[0].payload).not.toHaveProperty('notice_version')
  })
  it('sending the same powers again is not "more"', async () => {
    before({ chat: true })
    await expect(updateTeammate('tm1', 'a1', { capabilities: { chat: true } }, owner)).resolves.toEqual({ ok: true })
  })
})

describe('step 4: the Team list', () => {
  it('names the four states from the status and the switch-off stamp', () => {
    expect(teammateState({ status: 'active' })).toBe('active')
    expect(teammateState({ status: 'revoked', switched_off_at: '2026-11-18', switched_off_by: 'owner' })).toBe('off_owner')
    expect(teammateState({ status: 'revoked', switched_off_at: '2026-11-18', switched_off_by: 'td' })).toBe('off_td')
    expect(teammateState({ status: 'revoked' })).toBe('removed')
    expect(teammateState({ status: 'revoked', switched_off_at: null })).toBe('removed')
  })
  it('lists active and switched-off people, never the removed, with their powers cleaned', async () => {
    state.answers['portal_team_members:select'] = { data: [
      { id: 'a', status: 'active', capabilities: { chat: true, bogus: true } },
      { id: 'b', status: 'revoked', switched_off_at: '2026-11-18', switched_off_by: 'td', capabilities: {} },
      { id: 'c', status: 'revoked', capabilities: {} },
    ], error: null }
    const rows = await listTeammates('a1')
    expect(rows.map(r => [r.id, r.state])).toEqual([['a', 'active'], ['b', 'off_td']])
    expect(rows[0].capabilities).toEqual({ chat: true })
  })
  it('still lists people when the code runs before the database change (the switch-off fields are missing)', async () => {
    let n = 0
    Object.defineProperty(state.answers as Record<string, unknown>, 'portal_team_members:select', {
      get: () => (++n === 1 ? { data: null, error: { message: 'column switched_off_at does not exist' } } : { data: [{ id: 'a', status: 'active', capabilities: { chat: true } }], error: null }),
      configurable: true,
    })
    const rows = await listTeammates('a1')
    expect(rows.map(r => r.id)).toEqual(['a'])
    expect(n).toBe(2)
  })
})

describe('step 4: an owner cannot make TD\'s switch-off permanent', () => {
  it('refuses to remove a person Tony Durante LLC switched off', async () => {
    state.answers['portal_team_members:select'] = { data: { auth_user_id: 'u1', switched_off_by: 'td' }, error: null }
    await expect(revokeTeammate('tm1', 'a1', owner)).rejects.toThrow(/Tony Durante LLC switched this person off/)
    expect(state.ops.some(o => o.op === 'update')).toBe(false)
    expect(state.authUpdates).toEqual([])
  })
  it('still removes a person the owner switched off, or an active one', async () => {
    state.answers['portal_team_members:select'] = { data: { auth_user_id: 'u1', switched_off_by: 'owner' }, error: null }
    await expect(revokeTeammate('tm1', 'a1', owner)).resolves.toEqual({ ok: true })
  })
})
