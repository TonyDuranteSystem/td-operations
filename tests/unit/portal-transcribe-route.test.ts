import { beforeEach, describe, expect, it, vi } from 'vitest'

// "Show text" under a voice note in the client-portal chat (dev job 753b2909): who may open it, and the work around the speech call.

const SUPA = 'https://proj.supabase.co'
const URL_A = `${SUPA}/storage/v1/object/public/assets/chat/n1.m4a`

const state = vi.hoisted(() => ({
  user: null as null | { id: string; app_metadata: Record<string, unknown> },
  reads: [] as Array<{ attachments: unknown; deleted_at?: null; id?: string; account_id?: string | null; contact_id?: string | null }>,
  updates: [] as Array<{ attachments: unknown }>,
  transcribe: vi.fn(),
  fetchCalls: [] as Array<{ url: string; method: string }>,
  contentLength: '1000',
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }) }))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.reads.shift() ?? null }) }) }),
      update: (v: { attachments: unknown }) => ({ eq: async () => { state.updates.push(v); return { error: null } } }),
    }),
  },
}))
vi.mock('@/lib/portal-auth', () => ({ getClientContactId: () => 'c1' }))
vi.mock('@/lib/portal/team/gate', () => ({ canAccessAccount: async () => true }))
vi.mock('@/lib/portal/rate-limit', () => ({ checkRateLimit: () => ({ allowed: true }) }))
vi.mock('@/lib/marketing/voice-transcribe', () => ({ transcribeVoice: (...a: unknown[]) => state.transcribe(...a) }))

import { POST } from '@/app/api/portal/chat/message/[id]/transcribe/route'
import { NextRequest } from 'next/server'

const call = (index: unknown = 0) =>
  POST(new NextRequest('http://localhost/api/portal/chat/message/m1/transcribe', { method: 'POST', body: JSON.stringify({ index }) }), { params: Promise.resolve({ id: 'm1' }) })

const message = (extra: Record<string, unknown> = {}) => ({
  id: 'm1', account_id: 'a1', contact_id: 'c1', deleted_at: null,
  attachments: [{ url: URL_A, name: 'n1.m4a', mime_type: 'audio/mp4' }],
  ...extra,
})

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'sk-test'
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPA
  state.user = { id: 'u1', app_metadata: { role: 'admin' } }
  state.reads = [message()]
  state.updates = []
  state.fetchCalls = []
  state.contentLength = '1000'
  state.transcribe = vi.fn(async () => ({ ok: true, transcript: { text: 'ciao', language: 'italian', english: 'hello', at: 'now' } }))
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
    state.fetchCalls.push({ url, method: init?.method ?? 'GET' })
    return { ok: true, headers: { get: (h: string) => (h.toLowerCase() === 'content-length' ? state.contentLength : null) }, blob: async () => new Blob(['x']) }
  }))
})

describe('who may use "Show text" on a portal message', () => {
  it('a managed partner login is refused (isDashboardUser would have let it in)', async () => {
    state.user = { id: 'p1', app_metadata: { role: 'partner' } }
    expect((await call()).status).toBe(403)
    expect(state.transcribe).not.toHaveBeenCalled()
  })
  it('a marketing login is refused', async () => {
    state.user = { id: 'm1', app_metadata: { role: 'marketing' } }
    expect((await call()).status).toBe(403)
  })
  it('a signed-out request is refused', async () => {
    state.user = null
    expect((await call()).status).toBe(401)
  })
  it('TD staff and a client of the company are let in', async () => {
    expect((await call()).status).toBe(200)
    state.user = { id: 'u2', app_metadata: { role: 'client' } }
    state.reads = [message(), message()]
    expect((await call()).status).toBe(200)
  })
})

describe('the work around the speech call', () => {
  it('a note that already has its text is answered from the saved copy, with no speech call', async () => {
    state.reads = [message({ attachments: [{ url: URL_A, mime_type: 'audio/mp4', transcript: { text: 'saved', language: 'english', english: null, at: 't' } }] })]
    const res = await call()
    expect((await res.json()).cached).toBe(true)
    expect(state.transcribe).not.toHaveBeenCalled()
  })
  it('a note over 25 MB is refused from its size alone, without downloading it', async () => {
    state.contentLength = String(30 * 1024 * 1024)
    const res = await call()
    expect(res.status).toBe(400)
    expect(state.transcribe).not.toHaveBeenCalled()
    expect(state.fetchCalls.every(c => c.method === 'HEAD')).toBe(true)
  })
  it('saves the text onto a FRESH copy of the message, so a note added meanwhile is not wiped out', async () => {
    const second = { url: `${SUPA}/storage/v1/object/public/assets/chat/n2.m4a`, mime_type: 'audio/mp4' }
    state.reads = [message(), message({ attachments: [{ url: URL_A, name: 'n1.m4a', mime_type: 'audio/mp4' }, second] })]
    expect((await call()).status).toBe(200)
    expect(state.updates).toHaveLength(1)
    const saved = state.updates[0].attachments as Array<Record<string, unknown>>
    expect(saved).toHaveLength(2)
    expect(saved[0].transcript).toMatchObject({ text: 'ciao' })
    expect(saved[1]).toEqual(second)
  })
  it('a message the browser names that does not exist is a plain 404', async () => {
    state.reads = []
    expect((await call()).status).toBe(404)
  })
})
