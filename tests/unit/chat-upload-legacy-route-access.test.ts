/**
 * The OLD chat upload route (POST /api/portal/chat/upload, kept for tabs that loaded before the signed-URL change) now checks a TEAM login
 * the way /chat/upload-url does (dev job e59dd470, 20 Nov bug hunt A#6). Before, its access check ran only when the caller had a contact id,
 * so a team login — even one with no powers, on its temporary password, or waiting for its own notice — could put a file into ANY company's
 * folder of the public bucket and get a public link.
 *   - team login: only its own company AND only with the Chat tick (a waiting login's powers are held back); never a contact-only request;
 *   - a client with a contact, and staff: exactly as before.
 * The real gate (lib/portal/team/gate.ts) runs; only the identity lookup, the contact lookups and storage are faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PortalIdentity } from '@/lib/portal/resolve-portal-identity'

const h = vi.hoisted(() => ({
  user: null as null | { id: string; app_metadata: Record<string, unknown> },
  identity: { kind: 'none' } as unknown,
  contactAccounts: [] as string[],
  uploaded: [] as string[],
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }) }))
vi.mock('@/lib/portal/resolve-portal-identity', () => ({ resolvePortalIdentity: async () => h.identity }))
vi.mock('@/lib/portal-auth', () => ({
  getClientContactId: (u: { app_metadata?: Record<string, unknown> }) => (u.app_metadata?.contact_id as string | undefined) ?? null,
  getClientAccountIds: async () => h.contactAccounts,
}))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    storage: {
      from: () => ({
        upload: async (path: string) => { h.uploaded.push(path); return { error: null } },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://files.example/${path}` } }),
      }),
    },
  },
}))

import { POST } from '@/app/api/portal/chat/upload/route'

const OWN = 'company-own'
const OTHER = 'company-other'
const team = (caps: Record<string, boolean>, over: Record<string, unknown> = {}): PortalIdentity =>
  ({ kind: 'teammate', teamMemberId: 'tm1', accountId: OWN, displayName: 'Anna', email: null, capabilities: caps, createdAt: null, ...over }) as PortalIdentity

function png() {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])], 'a.png', { type: 'image/png' })
}
function call(fields: { account_id?: string; contact_id?: string }) {
  const fd = new FormData()
  fd.set('file', png())
  if (fields.account_id) fd.set('account_id', fields.account_id)
  if (fields.contact_id) fd.set('contact_id', fields.contact_id)
  return POST(new Request('http://x/api/portal/chat/upload', { method: 'POST', body: fd }) as never)
}

beforeEach(() => {
  h.user = { id: 'u1', app_metadata: { role: 'client', kind: 'team_member' } } // a team login: client role, NO contact id
  h.identity = team({ chat: true })
  h.contactAccounts = []
  h.uploaded = []
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('a TEAM login (client role, no contact id)', () => {
  it('with the Chat tick may upload into ITS OWN company', async () => {
    const res = await call({ account_id: OWN })
    expect(res.status).toBe(200)
    expect(h.uploaded).toHaveLength(1)
    expect(h.uploaded[0]).toMatch(new RegExp(`^chat-attachments/${OWN}/`))
  })
  it('may NOT upload into another company (the hole: any company folder of the public bucket)', async () => {
    const res = await call({ account_id: OTHER })
    expect(res.status).toBe(403)
    expect(h.uploaded).toEqual([])
  })
  it('without the Chat tick may not upload at all', async () => {
    h.identity = team({ documents: true })
    expect((await call({ account_id: OWN })).status).toBe(403)
    expect(h.uploaded).toEqual([])
  })
  it('with NO powers at all may not upload', async () => {
    h.identity = team({})
    expect((await call({ account_id: OWN })).status).toBe(403)
  })
  it('still waiting for its own notice (its powers are held back) may not upload even with a Chat tick on file', async () => {
    h.identity = team({}, { noticePending: true }) // resolvePortalIdentity hands a waiting login EMPTY powers
    expect((await call({ account_id: OWN })).status).toBe(403)
  })
  it('a request naming only a contact is refused (a team login has no contact thread)', async () => {
    expect((await call({ contact_id: 'some-contact' })).status).toBe(403)
    expect(h.uploaded).toEqual([])
  })
  it('naming its own company AND someone else\'s contact still files under its own company only', async () => {
    const res = await call({ account_id: OWN, contact_id: 'some-contact' })
    expect(res.status).toBe(200)
    expect(h.uploaded[0]).toMatch(new RegExp(`^chat-attachments/${OWN}/`))
  })
})

describe('a client login with NO portal identity (e.g. still on its temporary password)', () => {
  it('may not upload anywhere', async () => {
    h.identity = { kind: 'none' }
    expect((await call({ account_id: OWN })).status).toBe(403)
    expect(h.uploaded).toEqual([])
  })
})

describe('everyone else is exactly as before', () => {
  beforeEach(() => { h.user = { id: 'u2', app_metadata: { role: 'client', contact_id: 'c1' } } })
  it('a client with a contact may upload into a company they are linked to', async () => {
    h.contactAccounts = [OWN]
    expect((await call({ account_id: OWN })).status).toBe(200)
  })
  it('a client with a contact may NOT upload into a company they are not linked to', async () => {
    h.contactAccounts = [OWN]
    expect((await call({ account_id: OTHER })).status).toBe(403)
  })
  it('a client with a contact may NOT name another contact', async () => {
    expect((await call({ contact_id: 'c2' })).status).toBe(403)
    expect((await call({ contact_id: 'c1' })).status).toBe(200)
  })
  it('staff (not the client role) may upload as before', async () => {
    h.user = { id: 'u3', app_metadata: { role: 'admin' } }
    expect((await call({ account_id: OTHER })).status).toBe(200)
  })
  it('no sign-in is still refused first', async () => {
    h.user = null
    expect((await call({ account_id: OWN })).status).toBe(401)
  })
})
