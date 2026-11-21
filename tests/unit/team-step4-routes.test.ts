import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  getUser: vi.fn(), assertAdmin: vi.fn(), createTeammate: vi.fn(), updateTeammate: vi.fn(), revokeTeammate: vi.fn(),
  switchOff: vi.fn(), switchOn: vi.fn(), confirmGrant: vi.fn(), memberRow: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: m.getUser } }) }))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: m.memberRow(), error: null }) }) }) }) }) },
}))
vi.mock('@/lib/portal/team/confirm-request', () => ({ confirmGrant: m.confirmGrant }))
vi.mock('@/lib/portal/team/server', async () => {
  class ConfirmationRequiredError extends Error { code = 'confirmation_required' as const; constructor() { super('needs confirmation') } }
  return {
    ConfirmationRequiredError,
    assertAccountAdmin: m.assertAdmin, createTeammate: m.createTeammate, updateTeammate: m.updateTeammate, revokeTeammate: m.revokeTeammate,
    switchTeammateOff: m.switchOff, switchTeammateOn: m.switchOn, listTeammates: vi.fn(),
  }
})

import { POST as addTeammate } from '@/app/api/portal/team/route'
import { PATCH as editTeammate } from '@/app/api/portal/team/[id]/route'
import { POST as switchRoute } from '@/app/api/portal/team/[id]/switch/route'
import { ConfirmationRequiredError } from '@/lib/portal/team/server'
import { TeamSwitchError } from '@/lib/portal/team/switch'

const user = { id: 'u1', email: 'owner@example.com' }
const req = (body: unknown, headers: Record<string, string> = { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }) =>
  ({ json: async () => body, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, url: 'http://x/api/portal/team' }) as unknown as import('next/server').NextRequest
const proof = { notice_accepted: true, notice_version: 'v1-draft', notice_text: 'words', owner_password: 'pw' }
const confirmation = { version: 'v1-draft', text: 'words', ip: '203.0.113.9' }

beforeEach(() => {
  vi.clearAllMocks()
  m.getUser.mockResolvedValue({ data: { user } })
  m.assertAdmin.mockResolvedValue('c-owner')
  m.confirmGrant.mockResolvedValue({ ok: true, confirmation })
  m.createTeammate.mockResolvedValue({ ok: true, teamMemberId: 't1', username: 'anna', password: 'Temp-Pass-1234' })
  m.updateTeammate.mockResolvedValue({ ok: true })
  m.memberRow.mockReturnValue({ display_name: 'Anna Rossi' })
})

describe('POST /api/portal/team (add)', () => {
  const body = { account_id: 'a1', display_name: 'Anna Rossi', capabilities: { chat: true }, ...proof }
  it('needs a signed-in owner or member', async () => {
    m.getUser.mockResolvedValue({ data: { user: null } })
    expect((await addTeammate(req(body))).status).toBe(401)
    m.getUser.mockResolvedValue({ data: { user } }); m.assertAdmin.mockResolvedValue(null)
    expect((await addTeammate(req(body))).status).toBe(403)
    expect(m.createTeammate).not.toHaveBeenCalled()
  })
  it('creates nobody until the notice is accepted and the password is right (the proof is checked in the same request)', async () => {
    m.confirmGrant.mockResolvedValue({ ok: false, status: 403, error: 'That password is not correct.' })
    const res = await addTeammate(req(body))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('That password is not correct.')
    expect(m.createTeammate).not.toHaveBeenCalled()
    expect(m.confirmGrant).toHaveBeenCalledWith(expect.objectContaining({ mode: 'add', memberName: 'Anna Rossi', accountId: 'a1', ip: '203.0.113.9' }))
  })
  it('with the proof: creates the person, saving the notice version, the words and the address, and shows the password once', async () => {
    const res = await addTeammate(req(body))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, team_member_id: 't1', username: 'anna', password: 'Temp-Pass-1234' })
    expect(m.createTeammate).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'a1', createdByContactId: 'c-owner', disclaimerAccepted: true, noticeVersion: 'v1-draft', noticeText: 'words', ip: '203.0.113.9',
    }))
  })
})

describe('PATCH /api/portal/team/[id] (edit powers)', () => {
  const p = { params: { id: 'tm1' } }
  it('answers 409 "needs confirmation" when the powers would grow and no proof came, so the screen asks', async () => {
    m.updateTeammate.mockRejectedValue(new ConfirmationRequiredError())
    const res = await editTeammate(req({ account_id: 'a1', capabilities: { chat: true, documents: true } }), p)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ needs_confirmation: true })
    expect(m.confirmGrant).not.toHaveBeenCalled()
  })
  it('with the proof: checks it for "more powers" using the powers AFTER the change and the person\'s saved name, then saves', async () => {
    const res = await editTeammate(req({ account_id: 'a1', capabilities: { chat: true, documents: true, bogus: true }, ...proof }), p)
    expect(res.status).toBe(200)
    expect(m.confirmGrant).toHaveBeenCalledWith(expect.objectContaining({ mode: 'more', memberName: 'Anna Rossi', caps: { documents: true, chat: true } }))
    expect(m.updateTeammate).toHaveBeenCalledWith('tm1', 'a1', expect.anything(), expect.objectContaining({ kind: 'owner', contactId: 'c-owner' }), confirmation)
  })
  it('a wrong proof saves nothing', async () => {
    m.confirmGrant.mockResolvedValue({ ok: false, status: 429, error: 'Too many wrong passwords.' })
    const res = await editTeammate(req({ account_id: 'a1', capabilities: { chat: true }, ...proof }), p)
    expect(res.status).toBe(429)
    expect(m.updateTeammate).not.toHaveBeenCalled()
  })
  it('taking powers away needs no proof', async () => {
    const res = await editTeammate(req({ account_id: 'a1', capabilities: { chat: true } }), p)
    expect(res.status).toBe(200)
    expect(m.updateTeammate).toHaveBeenCalledWith('tm1', 'a1', expect.anything(), expect.anything(), null)
  })
  it('a person who is not on this company is 404, other failures are shown plainly', async () => {
    m.memberRow.mockReturnValue(null)
    expect((await editTeammate(req({ account_id: 'a1', capabilities: {}, ...proof }), p)).status).toBe(404)
    m.memberRow.mockReturnValue({ display_name: 'A' }); m.updateTeammate.mockRejectedValue(new Error('This team member is switched off or removed'))
    const res = await editTeammate(req({ account_id: 'a1', capabilities: { chat: true } }), p)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('switched off or removed')
  })
})

describe('POST /api/portal/team/[id]/switch', () => {
  const p = { params: { id: 'tm1' } }
  it('refuses a stranger, and anything that is not "off" or "on"', async () => {
    m.assertAdmin.mockResolvedValue(null)
    expect((await switchRoute(req({ account_id: 'a1', action: 'off' }), p)).status).toBe(403)
    m.assertAdmin.mockResolvedValue('c-owner')
    expect((await switchRoute(req({ account_id: 'a1', action: 'delete' }), p)).status).toBe(400)
    expect((await switchRoute(req({ account_id: 'a1' }), p)).status).toBe(400)
    expect(m.switchOff).not.toHaveBeenCalled(); expect(m.switchOn).not.toHaveBeenCalled()
  })
  it('switches off (with the owner as the actor and the reason) and back on', async () => {
    expect((await switchRoute(req({ account_id: 'a1', action: 'off', reason: 'left us' }), p)).status).toBe(200)
    expect(m.switchOff).toHaveBeenCalledWith('tm1', 'a1', expect.objectContaining({ kind: 'owner', contactId: 'c-owner' }), 'left us')
    expect((await switchRoute(req({ account_id: 'a1', action: 'on' }), p)).status).toBe(200)
    expect(m.switchOn).toHaveBeenCalledWith('tm1', 'a1', expect.objectContaining({ kind: 'owner', contactId: 'c-owner' }))
  })
  it('turns the rules into plain statuses: TD\'s lock 403, unknown person 404, a clash 409, anything else 400', async () => {
    const cases: Array<[ConstructorParameters<typeof TeamSwitchError>[0], number]> = [['td_locked', 403], ['not_found', 404], ['conflict', 409], ['removed', 400], ['already_off', 400]]
    for (const [code, status] of cases) {
      m.switchOn.mockRejectedValueOnce(new TeamSwitchError(code, `msg ${code}`))
      const res = await switchRoute(req({ account_id: 'a1', action: 'on' }), p)
      expect(res.status).toBe(status)
      expect(await res.json()).toMatchObject({ error: `msg ${code}`, code })
    }
  })
  it('an unexpected failure is a 500 with a plain message', async () => {
    m.switchOff.mockRejectedValueOnce(new Error('boom'))
    expect((await switchRoute(req({ account_id: 'a1', action: 'off' }), p)).status).toBe(500)
  })
})
