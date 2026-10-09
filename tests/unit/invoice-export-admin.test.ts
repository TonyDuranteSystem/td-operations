/**
 * The invoice export lists EVERY company's invoices. It must trust app_metadata (set only by the server), never the
 * user_metadata role that any logged-in user can write to themselves.
 */
import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({ user: null as unknown }))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }) }))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: () => { const c: Record<string, unknown> = {}; for (const m of ['select', 'not', 'order', 'eq', 'lt', 'lte', 'gte', 'in']) c[m] = () => c; c.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r); return c } },
}))

import { GET } from '@/app/api/portal/invoices/export/route'

const call = () => GET(new NextRequest('http://x/api/portal/invoices/export?format=csv'))

describe('GET /api/portal/invoices/export', () => {
  it('refuses a client who gave themselves user_metadata.role = admin', async () => {
    state.user = { id: 'u', email: 'client@example.com', app_metadata: { role: 'client' }, user_metadata: { role: 'admin' } }
    expect((await call()).status).toBe(401)
  })
  it('refuses a signed-out caller', async () => {
    state.user = null
    expect((await call()).status).toBe(401)
  })
  it('lets a real admin (app_metadata) through', async () => {
    state.user = { id: 'a', email: 'luca@tonydurante.us', app_metadata: { role: 'admin' }, user_metadata: {} }
    expect((await call()).status).not.toBe(401)
  })
})
