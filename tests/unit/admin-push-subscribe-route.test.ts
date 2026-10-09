/**
 * POST /api/admin/push — the TD Talk marker (dev job c1e326dd).
 *  - the CRM app's subscription never writes the new `app` column (so it keeps working even before the migration);
 *  - TD Talk's writes app = 'talk'; an unknown value is the CRM app;
 *  - the staff gate and the bad-subscription check still hold.
 * Plus a source guard: every sender that can push a DIRECT MESSAGE marks it `dm`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const h = vi.hoisted(() => ({
  user: { id: 'u1', email: 'a@b.c' } as null | { id: string; email: string },
  staff: true,
  inserts: [] as Array<Record<string, unknown>>,
  deletes: 0,
  insertError: null as null | { message: string },
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }) }))
vi.mock('@/lib/auth', () => ({ isStaffUser: () => h.staff }))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => ({
      delete: () => ({ eq: () => ({ eq: async () => { h.deletes++; return { error: null } } }) }),
      insert: async (row: Record<string, unknown>) => { h.inserts.push(row); return { error: h.insertError } },
    }),
  },
}))

import { POST } from '@/app/api/admin/push/route'

const sub = { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } }
const call = (body: unknown) => POST({ json: async () => body } as never)

beforeEach(() => { h.user = { id: 'u1', email: 'a@b.c' }; h.staff = true; h.inserts = []; h.deletes = 0; h.insertError = null })

describe('POST /api/admin/push', () => {
  it("the CRM app's subscription does not touch the app column", async () => {
    const res = await call({ subscription: sub })
    expect(res.status).toBe(200)
    expect(h.inserts).toHaveLength(1)
    expect('app' in h.inserts[0]).toBe(false)
  })
  it("TD Talk's subscription stores app = 'talk'", async () => {
    await call({ subscription: sub, app: 'talk' })
    expect(h.inserts[0].app).toBe('talk')
  })
  it('an unknown app value is treated as the CRM app', async () => {
    await call({ subscription: sub, app: 'evil' })
    expect('app' in h.inserts[0]).toBe(false)
  })
  it('still refuses a signed-out visitor, a non-staff user and a malformed subscription', async () => {
    h.user = null
    expect((await call({ subscription: sub })).status).toBe(401)
    h.user = { id: 'u1', email: 'a@b.c' }; h.staff = false
    expect((await call({ subscription: sub })).status).toBe(403)
    h.staff = true
    expect((await call({ subscription: { endpoint: 'x' } })).status).toBe(400)
    expect(h.inserts).toHaveLength(0)
  })
  it('reports a failed insert', async () => {
    h.insertError = { message: 'boom' }
    expect((await call({ subscription: sub })).status).toBe(500)
  })
})

describe('every sender that can push a direct message marks it dm', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8')
  it.each([
    ['app/api/team/threads/[id]/messages/route.ts', 2], // the DM branch and the mention-in-a-DM branch
    ['lib/team/post-message.ts', 2],
    ['lib/team/claude-trigger.ts', 1], // "Claude replied" in a DM
    ['app/api/team/share/route.ts', 1], // an item shared into a teammate's DM
  ])('%s sets dm on its direct-message pushes', (file, min) => {
    const src = read(file)
    const marks = (src.match(/\bdm:\s*[^,\n}]+/g) ?? []).length
    expect(marks).toBeGreaterThanOrEqual(min)
  })
})
