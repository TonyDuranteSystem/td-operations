import { describe, it, expect, vi, beforeEach } from 'vitest'

const { getUser, getUserById, updateUserById, sendEmail } = vi.hoisted(() => ({
  getUser: vi.fn(),
  getUserById: vi.fn(),
  updateUserById: vi.fn(),
  sendEmail: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser } }),
}))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { auth: { admin: { getUserById, updateUserById } } },
}))
vi.mock('@/lib/auth/staff-credentials', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/staff-credentials')>('@/lib/auth/staff-credentials')
  return { ...actual, sendStaffCredentialsEmail: sendEmail }
})

import { POST } from '@/app/api/team-management/reset-password/route'

const admin = { id: 'admin-1', email: 'antonio.durante@tonydurante.us', app_metadata: {}, user_metadata: {} }
const req = (body: unknown) =>
  ({ json: async () => body }) as unknown as import('next/server').NextRequest

const staffTarget = {
  id: 'luca-1',
  email: 'luca@tonydurante.us',
  app_metadata: { role: 'team' },
  user_metadata: { full_name: 'Luca Degsper', must_change_password: true, other: 'keep' },
}

beforeEach(() => {
  vi.clearAllMocks()
  getUser.mockResolvedValue({ data: { user: admin } })
  getUserById.mockResolvedValue({ data: { user: staffTarget }, error: null })
  updateUserById.mockResolvedValue({ error: null })
  sendEmail.mockResolvedValue(true)
})

describe('POST /api/team-management/reset-password', () => {
  it('refuses a caller who is not logged in', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(req({ user_id: 'luca-1' }))
    expect(res.status).toBe(403)
    expect(updateUserById).not.toHaveBeenCalled()
  })

  it('refuses a team member (not an admin)', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u', email: 'support@tonydurante.us', app_metadata: { role: 'team' }, user_metadata: {} } } })
    const res = await POST(req({ user_id: 'luca-1' }))
    expect(res.status).toBe(403)
    expect(updateUserById).not.toHaveBeenCalled()
  })

  it('does NOT trust a self-editable user_metadata admin role', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u', email: 'x@x.com', app_metadata: {}, user_metadata: { role: 'admin' } } } })
    const res = await POST(req({ user_id: 'luca-1' }))
    expect(res.status).toBe(403)
    expect(updateUserById).not.toHaveBeenCalled()
  })

  it('requires user_id', async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
  })

  it('refuses to reset your own password here', async () => {
    const res = await POST(req({ user_id: 'admin-1' }))
    expect(res.status).toBe(400)
    expect(updateUserById).not.toHaveBeenCalled()
  })

  it('returns 404 for an unknown user', async () => {
    getUserById.mockResolvedValue({ data: { user: null }, error: { message: 'nope' } })
    const res = await POST(req({ user_id: 'ghost' }))
    expect(res.status).toBe(404)
  })

  it('refuses a CLIENT account', async () => {
    getUserById.mockResolvedValue({ data: { user: { ...staffTarget, app_metadata: { role: 'client' } } }, error: null })
    const res = await POST(req({ user_id: 'luca-1' }))
    expect(res.status).toBe(400)
    expect(updateUserById).not.toHaveBeenCalled()
  })

  it('refuses the protected owner account when another admin asks', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'admin-2', email: 'x@tonydurante.us', app_metadata: { role: 'admin' }, user_metadata: {} } } })
    getUserById.mockResolvedValue({ data: { user: { ...staffTarget, id: 'antonio', email: 'antonio.durante@tonydurante.us' } }, error: null })
    const res = await POST(req({ user_id: 'antonio' }))
    expect(res.status).toBe(403)
    expect(updateUserById).not.toHaveBeenCalled()
  })

  it('refuses a PARTNER account', async () => {
    getUserById.mockResolvedValue({ data: { user: { ...staffTarget, app_metadata: { role: 'partner' } } }, error: null })
    const res = await POST(req({ user_id: 'luca-1' }))
    expect(res.status).toBe(400)
    expect(updateUserById).not.toHaveBeenCalled()
  })

  it('a non-owner admin cannot reset another ADMIN (e.g. Jodi)', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'admin-2', email: 'qa-staff@tonydurante.us', app_metadata: { role: 'admin' }, user_metadata: {} } } })
    getUserById.mockResolvedValue({ data: { user: { ...staffTarget, id: 'jodi', email: 'jodi@tonydurante.us', app_metadata: { role: 'admin' } } }, error: null })
    const res = await POST(req({ user_id: 'jodi' }))
    expect(res.status).toBe(403)
    expect(updateUserById).not.toHaveBeenCalled()
  })

  it('a non-owner admin CAN reset a plain team member', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'admin-2', email: 'qa-staff@tonydurante.us', app_metadata: { role: 'admin' }, user_metadata: {} } } })
    const res = await POST(req({ user_id: 'luca-1' }))
    expect(res.status).toBe(200)
    expect(updateUserById).toHaveBeenCalledTimes(1)
  })

  it('the owner CAN reset an admin (e.g. Jodi, who has never logged in)', async () => {
    getUserById.mockResolvedValue({ data: { user: { ...staffTarget, id: 'jodi', email: 'jodi@tonydurante.us', app_metadata: { role: 'admin' } } }, error: null })
    const res = await POST(req({ user_id: 'jodi' }))
    expect(res.status).toBe(200)
    expect(updateUserById).toHaveBeenCalledTimes(1)
  })

  it('resets a staff member: new password applied, metadata preserved, emailed, returned once', async () => {
    const res = await POST(req({ user_id: 'luca-1' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(body.emailSent).toBe(true)
    expect(body.tempPassword).toMatch(/^TD[a-z2-9]{10}!$/)

    const [id, attrs] = updateUserById.mock.calls[0]
    expect(id).toBe('luca-1')
    expect(attrs.password).toBe(body.tempPassword)
    expect(attrs.user_metadata).toEqual({ full_name: 'Luca Degsper', must_change_password: true, other: 'keep' })

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'reset', email: 'luca@tonydurante.us', tempPassword: body.tempPassword, role: 'team' }),
    )
  })

  it('still returns the password (emailSent=false) when the email fails', async () => {
    sendEmail.mockResolvedValue(false)
    const res = await POST(req({ user_id: 'luca-1' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.emailSent).toBe(false)
    expect(body.tempPassword).toBeTruthy()
  })

  it('does not email when the password update fails', async () => {
    updateUserById.mockResolvedValue({ error: { message: 'boom' } })
    const res = await POST(req({ user_id: 'luca-1' }))
    expect(res.status).toBe(500)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})
