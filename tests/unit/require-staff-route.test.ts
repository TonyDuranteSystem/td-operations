/**
 * The staff gate for API routes. This exists because `/api/*` is excluded from the middleware's
 * client-role bounce, so a route inherits only "is logged in" — a portal CLIENT has a login.
 * These tests pin the two properties that matter: staff pass, everyone else is refused, and a
 * broken identity check refuses rather than letting the caller through.
 */
import { describe, it, expect, vi } from 'vitest'

const getUser = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser } }),
}))

import { requireStaffRoute } from '@/lib/auth/require-staff-route'

const staff = { id: 'u1', app_metadata: { role: 'admin' }, user_metadata: {}, email: 'a@t.us' }
const team = { id: 'u2', app_metadata: { role: 'team' }, user_metadata: {}, email: 'b@t.us' }
const client = { id: 'u3', app_metadata: { role: 'client' }, user_metadata: {}, email: 'c@x.com' }

describe('requireStaffRoute', () => {
  it('lets an admin through (returns null)', async () => {
    getUser.mockImplementation(async () => ({ data: { user: staff } }))
    expect(await requireStaffRoute()).toBeNull()
  })

  it('lets a team member through', async () => {
    getUser.mockImplementation(async () => ({ data: { user: team } }))
    expect(await requireStaffRoute()).toBeNull()
  })

  it('REFUSES a portal client — the whole point', async () => {
    getUser.mockImplementation(async () => ({ data: { user: client } }))
    const res = await requireStaffRoute()
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })

  it('REFUSES an anonymous caller', async () => {
    getUser.mockImplementation(async () => ({ data: { user: null } }))
    expect((await requireStaffRoute())!.status).toBe(403)
  })

  it('FAILS CLOSED when the identity check itself throws', async () => {
    // throw at CALL time (not an eagerly-created rejected promise, which vitest reports as an
    // unhandled rejection before the guard ever sees it)
    getUser.mockImplementation(async () => { throw new Error('auth service down') })
    expect((await requireStaffRoute())!.status).toBe(403)
  })
})
