/**
 * Handler tests for three team routes that had NO test of their own (dev job e59dd470, 20 Nov hunt D#15):
 *   GET    /api/portal/team                    — the owner's list (a failure is a plain message, never "no team")
 *   DELETE /api/portal/team/[id]               — Remove for good
 *   POST   /api/portal/team/[id]/reset-password — the owner-managed password reset
 * Who may call (a signed-in owner or member of THAT company), what is passed down (the company and the owner as the actor), and what comes back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  getUser: vi.fn(),
  assertAdmin: vi.fn(),
  listTeammates: vi.fn(),
  revokeTeammate: vi.fn(),
  resetPassword: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: m.getUser } }) }))
vi.mock('@/lib/portal/team/server', () => ({
  assertAccountAdmin: m.assertAdmin,
  listTeammates: m.listTeammates,
  revokeTeammate: m.revokeTeammate,
  resetTeammatePassword: m.resetPassword,
  // the sibling routes of the same files import these; they are not exercised here
  createTeammate: vi.fn(),
  updateTeammate: vi.fn(),
  ConfirmationRequiredError: class extends Error {},
}))

import { GET as listRoute } from '@/app/api/portal/team/route'
import { DELETE as removeRoute } from '@/app/api/portal/team/[id]/route'
import { POST as resetRoute } from '@/app/api/portal/team/[id]/reset-password/route'

const user = { id: 'u1', email: 'owner@example.com' }
const req = (body: unknown, url = 'http://x/api/portal/team', headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }) =>
  ({ json: async () => body, url, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } }) as unknown as import('next/server').NextRequest

beforeEach(() => {
  vi.clearAllMocks()
  m.getUser.mockResolvedValue({ data: { user } })
  m.assertAdmin.mockResolvedValue('c-owner')
})

describe('GET /api/portal/team (the owner\'s list)', () => {
  it('needs a sign-in, and an owner or member of THAT company', async () => {
    m.getUser.mockResolvedValue({ data: { user: null } })
    expect((await listRoute(req({}, 'http://x/api/portal/team?account_id=a1'))).status).toBe(401)
    m.getUser.mockResolvedValue({ data: { user } })
    m.assertAdmin.mockResolvedValue(null)
    expect((await listRoute(req({}, 'http://x/api/portal/team?account_id=a1'))).status).toBe(403)
    expect(m.listTeammates).not.toHaveBeenCalled()
  })
  it('lists the teammates of the company named in the address', async () => {
    m.listTeammates.mockResolvedValue([{ id: 't1' }])
    const res = await listRoute(req({}, 'http://x/api/portal/team?account_id=a1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ teammates: [{ id: 't1' }] })
    expect(m.assertAdmin).toHaveBeenCalledWith(user, 'a1')
    expect(m.listTeammates).toHaveBeenCalledWith('a1')
  })
  it('a missing company id is refused by the admin check, never treated as "all companies"', async () => {
    m.assertAdmin.mockResolvedValue(null)
    expect((await listRoute(req({}, 'http://x/api/portal/team'))).status).toBe(403)
    expect(m.assertAdmin).toHaveBeenCalledWith(user, '')
  })
  it('a failed read is a plain message with a 500 — never an empty list', async () => {
    m.listTeammates.mockRejectedValue(new Error('db down'))
    const res = await listRoute(req({}, 'http://x/api/portal/team?account_id=a1'))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/could not load your team/i)
  })
})

describe('DELETE /api/portal/team/[id] (remove for good)', () => {
  it('needs a sign-in and an owner or member', async () => {
    m.getUser.mockResolvedValue({ data: { user: null } })
    expect((await removeRoute(req({ account_id: 'a1' }), { params: { id: 't1' } })).status).toBe(401)
    m.getUser.mockResolvedValue({ data: { user } })
    m.assertAdmin.mockResolvedValue(null)
    expect((await removeRoute(req({ account_id: 'a1' }), { params: { id: 't1' } })).status).toBe(403)
    expect(m.revokeTeammate).not.toHaveBeenCalled()
  })
  it('removes the person from THAT company, with the owner as the actor (and the address it came from)', async () => {
    m.revokeTeammate.mockResolvedValue({ ok: true })
    const res = await removeRoute(req({ account_id: 'a1' }), { params: { id: 't1' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(m.revokeTeammate).toHaveBeenCalledWith('t1', 'a1', expect.objectContaining({ kind: 'owner', contactId: 'c-owner', ip: '203.0.113.9' }))
  })
  it('a refusal comes back as its own message (400), e.g. TD switched the person off', async () => {
    m.revokeTeammate.mockRejectedValue(new Error('Tony Durante LLC switched this person off. Please contact us before removing them.'))
    const res = await removeRoute(req({ account_id: 'a1' }), { params: { id: 't1' } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('Tony Durante LLC switched this person off')
  })
})

describe('POST /api/portal/team/[id]/reset-password', () => {
  it('needs a sign-in and an owner or member of the company', async () => {
    m.getUser.mockResolvedValue({ data: { user: null } })
    expect((await resetRoute(req({ account_id: 'a1' }), { params: { id: 't1' } })).status).toBe(401)
    m.getUser.mockResolvedValue({ data: { user } })
    m.assertAdmin.mockResolvedValue(null)
    expect((await resetRoute(req({ account_id: 'a1' }), { params: { id: 't1' } })).status).toBe(403)
    expect(m.resetPassword).not.toHaveBeenCalled()
  })
  it('resets the password of that company\'s login as the owner and returns the new password ONCE', async () => {
    m.resetPassword.mockResolvedValue({ ok: true, username: 'anna', password: 'Temp-Pass-1234' })
    const res = await resetRoute(req({ account_id: 'a1' }), { params: { id: 't1' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, username: 'anna', password: 'Temp-Pass-1234' })
    expect(m.resetPassword).toHaveBeenCalledWith('t1', 'a1', expect.objectContaining({ kind: 'owner', contactId: 'c-owner', ip: '203.0.113.9' }))
  })
  it('a refusal (shares could not be ended, not a team login, switched off) is its own plain message with a 400 — no password in it', async () => {
    m.resetPassword.mockRejectedValue(new Error('The password was not reset: this login may share someone\'s personal documents and that sharing could not be stopped. Please try again.'))
    const res = await resetRoute(req({ account_id: 'a1' }), { params: { id: 't1' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('The password was not reset')
    expect(body.password).toBeUndefined()
  })
})
