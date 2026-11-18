import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  staff: vi.fn(),
  user: vi.fn(),
  off: vi.fn(),
  on: vi.fn(),
  load: vi.fn(),
}))
vi.mock('@/lib/auth/require-staff-route', () => ({ requireStaffRoute: h.staff }))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user() } }) } }) }))
vi.mock('@/lib/portal/team/server', () => ({ switchTeammateOff: h.off, switchTeammateOn: h.on }))
vi.mock('@/lib/portal/team/crm-server', () => ({ loadTeamCard: h.load }))

import { GET } from '@/app/api/accounts/[id]/team/route'
import { POST } from '@/app/api/accounts/[id]/team/[teamMemberId]/switch/route'
import { TeamSwitchError } from '@/lib/portal/team/switch'

const params = { id: 'acct-1', teamMemberId: 'tm-1' }
const post = (body: unknown) =>
  new NextRequest('http://x/api', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-forwarded-for': '5.6.7.8' } })

beforeEach(() => {
  vi.clearAllMocks()
  h.staff.mockResolvedValue(null)
  h.user.mockReturnValue({ email: 'luca@tonydurante.us' })
  h.off.mockResolvedValue({ ok: true })
  h.on.mockResolvedValue({ ok: true })
  h.load.mockResolvedValue({ ready: true, members: [] })
})

describe('GET /api/accounts/[id]/team', () => {
  it('refuses anyone who is not staff and reads nothing', async () => {
    h.staff.mockResolvedValue(NextResponse.json({ error: 'Not authorized' }, { status: 403 }))
    const res = await GET(new NextRequest('http://x/api'), { params: { id: 'acct-1' } })
    expect(res.status).toBe(403)
    expect(h.load).not.toHaveBeenCalled()
  })
  it('returns the team of THIS company only', async () => {
    const res = await GET(new NextRequest('http://x/api'), { params: { id: 'acct-1' } })
    expect(res.status).toBe(200)
    expect(h.load).toHaveBeenCalledWith('acct-1')
  })
})

describe('POST /api/accounts/[id]/team/[teamMemberId]/switch', () => {
  it('refuses anyone who is not staff and changes nothing', async () => {
    h.staff.mockResolvedValue(NextResponse.json({ error: 'Not authorized' }, { status: 403 }))
    expect((await POST(post({ action: 'off', reason: 'x' }), { params })).status).toBe(403)
    expect(h.off).not.toHaveBeenCalled()
    expect(h.on).not.toHaveBeenCalled()
  })
  it('refuses when there is no staff email to put in the record', async () => {
    h.user.mockReturnValue({ email: null })
    expect((await POST(post({ action: 'off', reason: 'x' }), { params })).status).toBe(403)
    expect(h.off).not.toHaveBeenCalled()
  })
  it('refuses an unknown action', async () => {
    expect((await POST(post({ action: 'delete' }), { params })).status).toBe(400)
    expect(h.off).not.toHaveBeenCalled()
  })
  it('switches off as TD with the staff login and address, scoped to the company in the address', async () => {
    const res = await POST(post({ action: 'off', reason: 'left the company' }), { params })
    expect(res.status).toBe(200)
    expect(h.off).toHaveBeenCalledWith('tm-1', 'acct-1', { kind: 'td', staffEmail: 'luca@tonydurante.us', ip: '5.6.7.8' }, 'left the company')
  })
  it('switches on as TD', async () => {
    expect((await POST(post({ action: 'on' }), { params })).status).toBe(200)
    expect(h.on).toHaveBeenCalledWith('tm-1', 'acct-1', { kind: 'td', staffEmail: 'luca@tonydurante.us', ip: '5.6.7.8' })
  })
  it('passes the plain reason to staff when a reason is missing (400) and a missing person (404)', async () => {
    h.off.mockRejectedValueOnce(new TeamSwitchError('reason_required', 'Say why you are switching this person off'))
    const a = await POST(post({ action: 'off' }), { params })
    expect(a.status).toBe(400)
    expect((await a.json()).error).toBe('Say why you are switching this person off')
    h.off.mockRejectedValueOnce(new TeamSwitchError('not_found', 'Team member not found'))
    expect((await POST(post({ action: 'off', reason: 'x' }), { params })).status).toBe(404)
  })
})
