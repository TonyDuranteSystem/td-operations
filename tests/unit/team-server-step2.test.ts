import { describe, it, expect, vi, beforeEach } from 'vitest'

// A tiny scripted fake of the database + login client: each .from(table) chain records what was done and answers from `script`.
const { state } = vi.hoisted(() => ({
  state: {
    ops: [] as Array<{ table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> }>,
    answers: {} as Record<string, unknown>,
    authUser: null as null | { app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> },
    authUpdates: [] as Array<{ id: string; attrs: Record<string, unknown> }>,
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
        updateUserById: async (id: string, attrs: Record<string, unknown>) => { state.authUpdates.push({ id, attrs }); return { error: null } },
        deleteUser: async () => ({ error: null }),
        createUser: async () => ({ data: { user: { id: 'u-new' } }, error: null }),
      },
    },
  },
}))
vi.mock('@/lib/portal/resolve-portal-identity', () => ({ resolvePortalIdentity: vi.fn() }))
vi.mock('@/lib/portal/team/account-admin', () => ({ isAccountAdmin: vi.fn() }))

import { resetTeammatePassword, updateTeammate, revokeTeammate, switchTeammateOff, switchTeammateOn } from '@/lib/portal/team/server'

const owner = { kind: 'owner' as const, contactId: 'c1', ip: '1.1.1.1' }
const td = { kind: 'td' as const, staffEmail: 'antonio.durante@tonydurante.us' }
const teamAuth = { app_metadata: { role: 'client', kind: 'team_member', account_id: 'a1' }, user_metadata: { x: 1 } }
const eventsWritten = () => state.ops.filter(o => o.table === 'portal_team_events' && o.op === 'insert').map(o => (o.payload as { event: string }).event)

beforeEach(() => {
  state.ops = []
  state.answers = {}
  state.authUser = teamAuth
  state.authUpdates = []
})

describe('resetTeammatePassword', () => {
  it('resets a real team login and records it', async () => {
    state.answers['portal_team_members:select'] = { data: { auth_user_id: 'u1', username: 'mario', status: 'active' }, error: null }
    const r = await resetTeammatePassword('tm1', 'a1', owner)
    expect(r.username).toBe('mario')
    expect(r.password.length).toBeGreaterThan(8)
    expect(state.authUpdates[0].attrs.user_metadata).toMatchObject({ must_change_password: true, x: 1 })
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
    await expect(updateTeammate('tm1', 'a1', { capabilities: { chat: true, documents: true } }, owner)).rejects.toThrow(/powers were not changed/)
    const updates = state.ops.filter(o => o.table === 'portal_team_members' && o.op === 'update')
    expect((updates[updates.length - 1].payload as { capabilities: unknown }).capabilities).toEqual({ chat: true })
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

describe('switch off / on through the real wiring', () => {
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
