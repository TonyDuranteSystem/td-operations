import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * lib/team/notify.ts — the replacement for the deleted broadcast helpers.
 *
 * This is the security-critical piece of the 2026-07-24 change: internal
 * notifications must go to STAFF, resolved by name, never to "every device in
 * the admin push table". Antonio: "the client's browser never has to get
 * anything about our business."
 *
 * The three properties asserted here are the ones a future refactor could
 * silently break:
 *   1. non-staff (a partner) never receives — proven through the REAL directory
 *      filter, not a hand-written role check in the test;
 *   2. the sender is excluded;
 *   3. a directory failure FAILS CLOSED (sends to nobody) rather than falling
 *      back to a broadcast.
 */

const { mockListAllAuthUsers, mockSendPushToAdminUsers } = vi.hoisted(() => ({
  mockListAllAuthUsers: vi.fn(),
  mockSendPushToAdminUsers: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/auth-admin-helpers', () => ({ listAllAuthUsers: mockListAllAuthUsers }))
vi.mock('@/lib/portal/web-push', () => ({ sendPushToAdminUsers: mockSendPushToAdminUsers }))

const PAYLOAD = { title: 't', body: 'b', url: '/team-chat', tag: 'x' }

// Shaped like the REAL production directory (verified 2026-07-22): admin, team,
// a managed partner, and a client.
const USERS = [
  { id: 'antonio', email: 'antonio.durante@tonydurante.us', app_metadata: { role: 'admin' }, user_metadata: { full_name: 'Antonio' } },
  { id: 'luca', email: 'support@tonydurante.us', app_metadata: { role: 'team' }, user_metadata: { full_name: 'Luca' } },
  { id: 'cris', email: 'cristian@sirioos.design', app_metadata: { role: 'partner' }, user_metadata: { full_name: 'Cris' } },
  { id: 'client', email: 'someclient@example.com', app_metadata: { role: 'client' }, user_metadata: {} },
]

describe('sendPushToStaffExcept', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSendPushToAdminUsers.mockResolvedValue({ sent: 1, failed: 0 })
  })

  it('sends to the other STAFF member only — never the partner, never the client', async () => {
    mockListAllAuthUsers.mockResolvedValue(USERS)
    const { sendPushToStaffExcept } = await import('@/lib/team/notify')

    await sendPushToStaffExcept('antonio', PAYLOAD)

    expect(mockSendPushToAdminUsers).toHaveBeenCalledTimes(1)
    const ids = mockSendPushToAdminUsers.mock.calls[0][0]
    expect(ids).toEqual(['luca'])
    expect(ids).not.toContain('cris')
    expect(ids).not.toContain('client')
    expect(ids).not.toContain('antonio')
  })

  it('sends to every staff member when nobody is excluded (Claude is not a real user)', async () => {
    mockListAllAuthUsers.mockResolvedValue(USERS)
    const { sendPushToStaff } = await import('@/lib/team/notify')

    await sendPushToStaff(PAYLOAD)

    const ids = mockSendPushToAdminUsers.mock.calls[0][0]
    expect(new Set(ids)).toEqual(new Set(['antonio', 'luca']))
  })

  it('FAILS CLOSED when the staff directory errors — never falls back to a broadcast', async () => {
    mockListAllAuthUsers.mockRejectedValue(new Error('auth admin down'))
    const { sendPushToStaffExcept } = await import('@/lib/team/notify')

    const res = await sendPushToStaffExcept('antonio', PAYLOAD)

    expect(res).toEqual({ sent: 0, failed: 0 })
    expect(mockSendPushToAdminUsers).not.toHaveBeenCalled()
  })

  it('does not call the sender when they are the only staff member', async () => {
    mockListAllAuthUsers.mockResolvedValue([USERS[0], USERS[2], USERS[3]])
    const { sendPushToStaffExcept } = await import('@/lib/team/notify')

    const res = await sendPushToStaffExcept('antonio', PAYLOAD)

    expect(res).toEqual({ sent: 0, failed: 0 })
    expect(mockSendPushToAdminUsers).not.toHaveBeenCalled()
  })

  it('honours alsoExclude — someone already told the specific thing is not told the generic one', () => {
    // The send route pushes "@mentioned you" to the named people, then the plain
    // "#td-bug · Antonio" to everyone else. Without alsoExclude the mentioned
    // person gets BOTH, or (worse, the shape this replaced) everyone gets a
    // single push claiming they were mentioned.
    mockListAllAuthUsers.mockResolvedValue(USERS)
    return import('@/lib/team/notify').then(async ({ sendPushToStaffExcept }) => {
      await sendPushToStaffExcept('antonio', PAYLOAD, ['luca'])
      expect(mockSendPushToAdminUsers).not.toHaveBeenCalled()
    })
  })

  it('excludes a banned staff account (a revoked teammate keeps receiving otherwise)', async () => {
    mockListAllAuthUsers.mockResolvedValue([
      USERS[0],
      { ...USERS[1], banned_until: '2030-01-01T00:00:00Z' },
    ])
    const { sendPushToStaffExcept } = await import('@/lib/team/notify')

    await sendPushToStaffExcept('antonio', PAYLOAD)
    expect(mockSendPushToAdminUsers).not.toHaveBeenCalled()
  })
})
