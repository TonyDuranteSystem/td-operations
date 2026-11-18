import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { isTeamLogin, teamMustChangePassword } from '@/lib/portal/team/password-flag'
import { resolvePortalIdentity, type ResolveDeps } from '@/lib/portal/resolve-portal-identity'
import { provisionTeammate, type ProvisionDeps } from '@/lib/portal/team/provision'

const team = (meta: Record<string, unknown> = {}) => ({ id: 'u-team', app_metadata: { role: 'client', kind: 'team_member', account_id: 'a1', ...meta }, user_metadata: {} }) as never

describe('the server-side "choose your own password" flag', () => {
  it('is on only for a team login that carries the server-written flag', () => {
    expect(teamMustChangePassword({ app_metadata: { kind: 'team_member', must_change_password: true } })).toBe(true)
    expect(teamMustChangePassword({ app_metadata: { kind: 'team_member', must_change_password: false } })).toBe(false)
    expect(teamMustChangePassword({ app_metadata: { kind: 'team_member' } })).toBe(false)
    expect(teamMustChangePassword({ app_metadata: { kind: 'team_member', must_change_password: 'true' } })).toBe(false)
    // a normal client carrying the same key is not a team login: nothing changes for them
    expect(teamMustChangePassword({ app_metadata: { must_change_password: true } })).toBe(false)
    expect(isTeamLogin({ app_metadata: { kind: 'team_member' } })).toBe(true)
    expect(isTeamLogin({ app_metadata: undefined as never })).toBe(false)
  })
})

describe('identity of a team login on its temporary password', () => {
  const deps = (): ResolveDeps => ({
    fetchTeamMemberByAuthId: async () => ({ id: 'tm1', account_id: 'a1', display_name: 'Anna', email: null, capabilities: { documents: true }, status: 'active' }),
    getContactId: () => null,
    getAccountIds: async () => [],
  })
  it('has NO access while the flag is on, even though the person is active and has powers', async () => {
    expect(await resolvePortalIdentity(team({ must_change_password: true }), deps())).toEqual({ kind: 'none' })
  })
  it('does not even look the person up while the flag is on', async () => {
    const d = deps(); const spy = vi.spyOn(d, 'fetchTeamMemberByAuthId')
    await resolvePortalIdentity(team({ must_change_password: true }), d)
    expect(spy).not.toHaveBeenCalled()
  })
  it('is a normal team member once the flag is off or absent (the 3 people already on a team are unaffected)', async () => {
    for (const meta of [{}, { must_change_password: false }]) {
      expect(await resolvePortalIdentity(team(meta), deps())).toMatchObject({ kind: 'teammate', accountId: 'a1', capabilities: { documents: true } })
    }
  })
  it('the person editing their own user metadata from the browser changes nothing (only app metadata counts)', async () => {
    const user = { id: 'u-team', app_metadata: { role: 'client', kind: 'team_member', must_change_password: true }, user_metadata: { must_change_password: false } } as never
    expect(await resolvePortalIdentity(user, deps())).toEqual({ kind: 'none' })
  })
})

describe('a new team login is created with the flag', () => {
  it('puts the flag in app metadata (server-written), and keeps the screen hint in user metadata', async () => {
    const seen: { appMetadata?: Record<string, unknown>; userMetadata?: Record<string, unknown> } = {}
    const deps: ProvisionDeps = {
      usernameTaken: async () => false,
      createAuthUser: async (p) => { seen.appMetadata = p.appMetadata; seen.userMetadata = p.userMetadata; return { id: 'u1' } },
      insertTeamMember: async () => ({ id: 't1' }),
      newToken: () => 'tok',
      makePassword: () => 'Abcd-Efgh-Jkmn',
    }
    await provisionTeammate({ accountId: 'a1', username: 'anna.rossi', displayName: 'Anna Rossi', capabilities: {}, createdByContactId: 'c1', disclaimerAccepted: true }, deps)
    expect(seen.appMetadata).toMatchObject({ kind: 'team_member', role: 'client', account_id: 'a1', must_change_password: true })
    expect(seen.userMetadata).toMatchObject({ must_change_password: true })
  })
})

describe('POST /api/portal/change-password', () => {
  const m = vi.hoisted(() => ({ getUser: vi.fn(), updateUserById: vi.fn() }))
  vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: m.getUser } }) }))
  vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { auth: { admin: { updateUserById: m.updateUserById } } } }))

  const req = (body: unknown) => ({ json: async () => body }) as unknown as import('next/server').NextRequest
  beforeEach(() => { vi.clearAllMocks(); m.updateUserById.mockResolvedValue({ error: null }) })

  it('setting a new password clears the server flag of a team login (and the screen hint)', async () => {
    const { POST } = await import('@/app/api/portal/change-password/route')
    m.getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'x@y.z', app_metadata: { role: 'client', kind: 'team_member', account_id: 'a1', must_change_password: true }, user_metadata: { must_change_password: true, display_name: 'Anna' } } } })
    const res = await POST(req({ password: 'my-own-password' }))
    expect(res.status).toBe(200)
    expect(m.updateUserById).toHaveBeenCalledWith('u1', {
      password: 'my-own-password',
      user_metadata: { must_change_password: false, display_name: 'Anna' },
      app_metadata: { role: 'client', kind: 'team_member', account_id: 'a1', must_change_password: false },
    })
  })
  it('a normal client is unchanged: their app metadata is not touched', async () => {
    const { POST } = await import('@/app/api/portal/change-password/route')
    m.getUser.mockResolvedValue({ data: { user: { id: 'u2', email: 'c@y.z', app_metadata: { role: 'client', contact_id: 'c9' }, user_metadata: { must_change_password: true } } } })
    expect((await POST(req({ password: 'my-own-password' }))).status).toBe(200)
    const attrs = m.updateUserById.mock.calls[0][1] as Record<string, unknown>
    expect(attrs).not.toHaveProperty('app_metadata')
    expect(attrs.user_metadata).toMatchObject({ must_change_password: false })
  })
  it('refuses a short password, and a stranger', async () => {
    const { POST } = await import('@/app/api/portal/change-password/route')
    m.getUser.mockResolvedValue({ data: { user: { id: 'u1', app_metadata: {}, user_metadata: {} } } })
    expect((await POST(req({ password: 'short' }))).status).toBe(400)
    m.getUser.mockResolvedValue({ data: { user: null } })
    expect((await POST(req({ password: 'my-own-password' }))).status).toBe(401)
    expect(m.updateUserById).not.toHaveBeenCalled()
  })
})

describe('the screens', () => {
  const read = (p: string) => readFileSync(p, 'utf8')
  it('the portal layout shows a flagged team login ONLY the password page, before it ever resolves access', () => {
    const l = read('app/portal/layout.tsx')
    const flagged = l.indexOf('if (teamMustChangePassword(user))')
    const resolve = l.indexOf('const identity = await resolvePortalIdentity(user)')
    expect(flagged).toBeGreaterThan(-1)
    expect(flagged).toBeLessThan(resolve)
    expect(l.slice(flagged, resolve)).toContain('<PasswordGate mustChangePassword />')
    expect(l.slice(flagged, resolve)).not.toContain('PortalSidebar')
  })
  it('the phone app says to choose the password on the website first', () => {
    expect(read('lib/portal-app/load.ts')).toContain('teamMustChangePassword(user)')
  })
  it('a password reset by the owner puts the flag back', () => {
    expect(read('lib/portal/team/server.ts')).toContain('app_metadata: { ...meta, must_change_password: true }')
  })
})
