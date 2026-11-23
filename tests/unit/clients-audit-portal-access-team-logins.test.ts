/**
 * POST /api/clients/audit/[id]/portal-access — the team-login step (dev job e59dd470, D#10):
 *   - Block also switches off the company's active team logins (as the staff login, with the block's reason), in BOTH paths
 *     (company with contacts, company with none);
 *   - Restore switches back on only the logins the block switched off;
 *   - a problem with the team logins never undoes or fails the contact result: it is reported next to it;
 *   - no staff email → nothing changes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Answer = { data: unknown; error: { message: string } | null }
const h = vi.hoisted(() => ({
  answers: {} as Record<string, Answer>,
  inserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  authUpdates: [] as Array<{ id: string; attrs: Record<string, unknown> }>,
  staffEmail: 'staff@example.com' as string | null,
  denied: null as unknown,
  off: vi.fn(),
  on: vi.fn(),
}))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain = (op: string, payload?: Record<string, unknown>) => {
        if (op === 'insert') h.inserts.push({ table, payload: payload ?? {} })
        const c: Record<string, unknown> = {}
        c.eq = () => c
        c.neq = () => c
        c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          Promise.resolve(h.answers[`${table}:${op}`] ?? { data: [], error: null }).then(res, rej)
        return c
      }
      return {
        select: () => chain('select'),
        update: (p: Record<string, unknown>) => chain('update', p),
        insert: (p: Record<string, unknown>) => chain('insert', p),
      }
    },
    auth: { admin: { updateUserById: async (id: string, attrs: Record<string, unknown>) => { h.authUpdates.push({ id, attrs }); return { error: null } } } },
  },
}))
vi.mock('@/lib/auth-admin-helpers', () => ({ findAuthUserByEmail: async (email: string) => ({ id: `auth-${email}` }) }))
vi.mock('@/lib/auth/require-staff-route', () => ({ requireStaffRoute: async () => h.denied }))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.staffEmail ? { email: h.staffEmail } : null } }) } }) }))
vi.mock('@/lib/portal/team/server', () => ({ switchTeammateOff: h.off, switchTeammateOn: h.on }))

import { POST } from '@/app/api/clients/audit/[id]/portal-access/route'
import { COMPANY_BLOCK_REASON } from '@/lib/portal/team/company-block'

const link = { contact_id: 'c1', contact: { id: 'c1', full_name: 'Peter', email: 'peter@example.com' } }
const tm = (over: Record<string, unknown>) => ({ id: 'x', username: 'x', status: 'active', switched_off_at: null, switched_off_by: null, switched_off_reason: null, ...over })
const call = (action: string) =>
  POST(new Request('http://x/api/clients/audit/acc1/portal-access', { method: 'POST', headers: { 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({ action }) }) as never, { params: { id: 'acc1' } })

beforeEach(() => {
  h.answers = {}
  h.inserts = []
  h.authUpdates = []
  h.staffEmail = 'staff@example.com'
  h.denied = null
  h.off.mockReset()
  h.on.mockReset()
  h.off.mockResolvedValue(undefined)
  h.on.mockResolvedValue(undefined)
})

describe('Block portal login (deactivate)', () => {
  it('bans the owners AND switches off the active team logins, as the staff login, with the block reason', async () => {
    h.answers['account_contacts:select'] = { data: [link], error: null }
    h.answers['portal_team_members:select'] = { data: [tm({ id: 'a', username: 'anna' }), tm({ id: 'o', username: 'omar', status: 'revoked', switched_off_at: 't', switched_off_by: 'owner', switched_off_reason: 'holiday' })], error: null }
    const res = await call('deactivate')
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(h.authUpdates).toHaveLength(1) // the owner's sign-in
    expect(h.off).toHaveBeenCalledTimes(1)
    expect(h.off).toHaveBeenCalledWith('a', 'acc1', { kind: 'td', staffEmail: 'staff@example.com', ip: '9.9.9.9' }, COMPANY_BLOCK_REASON)
    expect(body.teamLogins).toMatchObject({ changed: 1, skipped: 1, failed: [] })
    expect(body.teamLoginsNote).toBe('1 team login switched off; 1 left as they were')
    expect(body.contactBlocks[0].reason).toBe('banned')
    const log = h.inserts.find((i) => i.table === 'action_log' && i.payload.table_name === 'auth.users')!
    expect(String(log.payload.summary)).toContain('team logins: 1 team login switched off')
  })
  it('a company with NO contacts still has its team logins switched off', async () => {
    h.answers['account_contacts:select'] = { data: [], error: null }
    h.answers['portal_team_members:select'] = { data: [tm({ id: 'a', username: 'anna' })], error: null }
    const body = await (await call('deactivate')).json()
    expect(h.off).toHaveBeenCalledTimes(1)
    expect(body.accountTierSet).toBeNull()
    expect(body.teamLogins).toMatchObject({ changed: 1 })
  })
  it('an unreadable team list is reported next to the owners\' result and never undoes or fails it', async () => {
    h.answers['account_contacts:select'] = { data: [link], error: null }
    h.answers['portal_team_members:select'] = { data: null, error: { message: 'team list down' } }
    const res = await call('deactivate')
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.contactBlocks[0].reason).toBe('banned')
    expect(body.teamLogins).toBeNull()
    expect(body.teamLoginsError).toBe('team list down')
    expect(body.teamLoginsNote).toContain('could not be checked')
    expect(h.off).not.toHaveBeenCalled()
  })
  it('a team login that fails is reported by name; the others are still switched off', async () => {
    h.answers['account_contacts:select'] = { data: [link], error: null }
    h.answers['portal_team_members:select'] = { data: [tm({ id: 'a', username: 'anna' }), tm({ id: 'b', username: 'bob' })], error: null }
    h.off.mockImplementation(async (id: string) => { if (id === 'a') throw new Error('ban step failed') })
    const body = await (await call('deactivate')).json()
    expect(h.off).toHaveBeenCalledTimes(2)
    expect(body.teamLogins.changed).toBe(1)
    expect(body.teamLogins.failed).toEqual([{ loginId: 'a', username: 'anna', error: 'ban step failed' }])
    expect(body.teamLoginsNote).toContain('1 could not be switched off (anna)')
  })
})

describe('Restore portal login (activate)', () => {
  it('unbans the owners and switches back on ONLY the team logins the block switched off', async () => {
    h.answers['account_contacts:select'] = { data: [link], error: null }
    h.answers['portal_team_members:select'] = {
      data: [
        tm({ id: 'a', username: 'anna', status: 'revoked', switched_off_at: 't', switched_off_by: 'td', switched_off_reason: COMPANY_BLOCK_REASON }),
        tm({ id: 'o', username: 'omar', status: 'revoked', switched_off_at: 't', switched_off_by: 'owner', switched_off_reason: 'holiday' }),
      ],
      error: null,
    }
    const body = await (await call('activate')).json()
    expect(h.on).toHaveBeenCalledTimes(1)
    expect(h.on).toHaveBeenCalledWith('a', 'acc1', { kind: 'td', staffEmail: 'staff@example.com', ip: '9.9.9.9' })
    expect(h.off).not.toHaveBeenCalled()
    expect(body.teamLogins).toMatchObject({ changed: 1, skipped: 1 })
    expect(body.contactBlocks[0].reason).toBe('unbanned')
  })
})

describe('guards', () => {
  it('without a staff email nothing changes', async () => {
    h.staffEmail = null
    h.answers['account_contacts:select'] = { data: [link], error: null }
    const res = await call('deactivate')
    expect(res.status).toBe(403)
    expect(h.authUpdates).toEqual([])
    expect(h.off).not.toHaveBeenCalled()
  })
  it('a bad action is still refused before anything else', async () => {
    const res = await call('nope')
    expect(res.status).toBe(400)
    expect(h.off).not.toHaveBeenCalled()
  })
})
