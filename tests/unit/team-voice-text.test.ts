/**
 * "Show text" under a voice note in Team Chat / TD Talk (dev job c1e326dd): the pure rules, the route against a fake
 * database + fake speech service, and source guards for the two UI surfaces and the background-tab read fix.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  isTrustedAudioUrl, needsEnglish, pickVoiceAttachment, transcriptLines, withTranscript, type VoiceTranscript,
} from '@/lib/team/voice-text'

const T: VoiceTranscript = { text: 'ciao a tutti', language: 'italian', english: 'hello everyone', at: '2026-10-09T00:00:00Z' }

describe('voice-text rules', () => {
  it('picks only an existing audio attachment', () => {
    const atts = [{ url: 'u1', name: 'a.png', mime_type: 'image/png' }, { url: 'u2', name: 'v.m4a', mime_type: 'audio/mp4' }, { url: 'u3', name: 'note.ogg' }]
    expect(pickVoiceAttachment(atts, 1)?.url).toBe('u2')
    expect(pickVoiceAttachment(atts, 2)?.url).toBe('u3') // no mime: falls back to the extension
    expect(pickVoiceAttachment(atts, 0)).toBeNull()
    expect(pickVoiceAttachment(atts, 5)).toBeNull()
    expect(pickVoiceAttachment(atts, -1)).toBeNull()
    expect(pickVoiceAttachment(atts, '1')).toBeNull()
    expect(pickVoiceAttachment(null, 0)).toBeNull()
  })
  it('only trusts audio on our own storage host, and fails closed without config', () => {
    expect(isTrustedAudioUrl('https://p.supabase.co/storage/v1/x.m4a', 'https://p.supabase.co')).toBe(true)
    expect(isTrustedAudioUrl('https://p.supabase.co.evil.com/x.m4a', 'https://p.supabase.co')).toBe(false)
    expect(isTrustedAudioUrl('https://p.supabase.co/x', 'https://p.supabase.co/')).toBe(true)
    expect(isTrustedAudioUrl('https://p.supabase.co/x', undefined)).toBe(false)
  })
  it('translates anything that is not English', () => {
    expect(needsEnglish('italian')).toBe(true)
    expect(needsEnglish('english')).toBe(false)
    expect(needsEnglish('en')).toBe(false)
    expect(needsEnglish('')).toBe(false)
  })
  it('writes the transcript on the right attachment only, matched by url', () => {
    const atts = [{ url: 'a', name: 'a' }, { url: 'b', name: 'b' }]
    const out = withTranscript(atts, 1, 'b', T)!
    expect(out[1].transcript).toEqual(T)
    expect(out[0].transcript).toBeUndefined()
    expect(withTranscript(atts, 1, 'other', T)).toBeNull()
    expect(withTranscript(atts, 9, 'b', T)).toBeNull()
  })
  it('shows English first, then the original', () => {
    expect(transcriptLines(T)).toEqual([{ label: 'English', text: 'hello everyone' }, { label: 'Italian', text: 'ciao a tutti' }])
    expect(transcriptLines({ ...T, language: 'english', english: null })).toEqual([{ label: 'Text', text: 'ciao a tutti' }])
  })
})

type Row = Record<string, unknown>
const h = vi.hoisted(() => ({
  user: { id: 'me', app_metadata: {} } as Record<string, unknown> | null,
  messages: [] as Row[],
  threads: [] as Row[],
  members: [] as string[],
  updates: [] as Row[],
  whisperCalls: [] as string[],
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }) }))
vi.mock('@/lib/auth', () => ({ isDashboardUser: () => true }))
vi.mock('@/lib/portal/rate-limit', () => ({ checkRateLimit: () => ({ allowed: true }) }))
vi.mock('@/lib/team/groups', () => ({
  assertGroupAccess: async (threadId: string, userId: string) => {
    const t = h.threads.find(x => x.id === threadId)
    if (!t || t.thread_type !== 'group') return { kind: 'not_group', members: [] }
    return h.members.includes(userId) ? { kind: 'member', members: h.members } : { kind: 'denied', members: [] }
  },
}))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      let filterId: unknown
      let patch: Row | null = null
      const api: Record<string, unknown> = {
        select: () => api,
        eq: (_c: string, v: unknown) => { filterId = v; return api },
        update: (p: Row) => { patch = p; return api },
        maybeSingle: async () => {
          const rows = table === 'internal_messages' ? h.messages : h.threads
          return { data: rows.find(r => r.id === filterId) ?? null, error: null }
        },
        then: (res: (v: unknown) => void) => {
          if (patch) { h.updates.push(patch); const m = h.messages.find(r => r.id === filterId); if (m) Object.assign(m, patch) }
          res({ data: null, error: null })
        },
      }
      return api
    },
  },
}))

import { POST } from '@/app/api/team/messages/[id]/transcribe/route'

const SB = 'https://p.supabase.co'
function call(id: string, body: unknown) {
  const req = new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) })
  return POST(req as never, { params: Promise.resolve({ id }) })
}

describe('POST /api/team/messages/[id]/transcribe', () => {
  beforeEach(() => {
    h.user = { id: 'me' }
    h.updates = []; h.whisperCalls = []; h.members = ['me', 'luca']
    h.threads = [{ id: 'dm1', thread_type: 'dm', dm_key: 'me:luca' }, { id: 'g1', thread_type: 'group' }]
    h.messages = [{ id: 'm1', thread_id: 'dm1', deleted_at: null, attachments: [{ url: `${SB}/storage/v1/a.m4a`, name: 'a.m4a', mime_type: 'audio/mp4' }] }]
    process.env.OPENAI_API_KEY = 'k'
    process.env.NEXT_PUBLIC_SUPABASE_URL = SB
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith(SB)) return new Response(new Blob(['x'.repeat(2000)]), { status: 200 })
      h.whisperCalls.push(url)
      if (url.endsWith('/transcriptions')) return new Response(JSON.stringify({ text: 'ciao', language: 'italian' }), { status: 200 })
      return new Response(JSON.stringify({ text: 'hello' }), { status: 200 })
    }))
  })

  it('transcribes + translates, saves it on the attachment, and a second tap does not call the speech service again', async () => {
    const r = await call('m1', { index: 0 })
    expect(r.status).toBe(200)
    expect((await r.json()).transcript).toMatchObject({ text: 'ciao', language: 'italian', english: 'hello' })
    expect(h.whisperCalls.length).toBe(2)
    expect(((h.messages[0].attachments as Row[])[0]).transcript).toMatchObject({ english: 'hello' })
    const again = await call('m1', { index: 0 })
    expect((await again.json()).cached).toBe(true)
    expect(h.whisperCalls.length).toBe(2)
  })
  it('does not translate English', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith(SB)) return new Response(new Blob(['x'.repeat(2000)]), { status: 200 })
      h.whisperCalls.push(url)
      return new Response(JSON.stringify({ text: 'hi', language: 'english' }), { status: 200 })
    }))
    const r = await call('m1', { index: 0 })
    expect((await r.json()).transcript.english).toBeNull()
    expect(h.whisperCalls.length).toBe(1)
  })
  it("refuses someone else's direct message and a group the caller is not in", async () => {
    h.user = { id: 'stranger' }
    expect((await call('m1', { index: 0 })).status).toBe(403)
    h.messages.push({ id: 'm2', thread_id: 'g1', deleted_at: null, attachments: [{ url: `${SB}/a.m4a`, name: 'a.m4a', mime_type: 'audio/mp4' }] })
    expect((await call('m2', { index: 0 })).status).toBe(403)
    expect(h.whisperCalls.length).toBe(0)
  })
  it('refuses a non-voice attachment, a deleted message and an audio url on another host', async () => {
    h.messages.push({ id: 'img', thread_id: 'dm1', deleted_at: null, attachments: [{ url: `${SB}/p.png`, name: 'p.png', mime_type: 'image/png' }] })
    expect((await call('img', { index: 0 })).status).toBe(400)
    h.messages.push({ id: 'del', thread_id: 'dm1', deleted_at: 'x', attachments: [] })
    expect((await call('del', { index: 0 })).status).toBe(404)
    h.messages.push({ id: 'evil', thread_id: 'dm1', deleted_at: null, attachments: [{ url: 'https://evil.com/a.m4a', name: 'a.m4a', mime_type: 'audio/mp4' }] })
    expect((await call('evil', { index: 0 })).status).toBe(400)
  })
  it('says so plainly when the speech service is not configured', async () => {
    delete process.env.OPENAI_API_KEY
    const r = await call('m1', { index: 0 })
    expect(r.status).toBe(503)
    expect((await r.json()).error).toMatch(/not configured/i)
  })
})

describe('UI + read-mark source guards', () => {
  const read = (p: string) => readFileSync(join(__dirname, '../../', p), 'utf8')
  it('TD Talk and the CRM Team Chat page both use the shared voice note (inline player + Show text)', () => {
    expect(read('components/talk/talk-messages.tsx')).toContain('<VoiceNote')
    expect(read('app/(dashboard)/team-chat/page.tsx')).toContain('<VoiceNote')
  })
  it('neither the CRM Team Chat page nor TD Talk marks a chat read while the window is hidden or behind another one', () => {
    expect(read('app/(dashboard)/team-chat/page.tsx')).toContain("(document.visibilityState === 'hidden' || !document.hasFocus()) ? 'mark_read=0'")
    const talk = read('components/talk/talk-app.tsx')
    expect(talk).toContain("document.visibilityState === 'visible' && document.hasFocus()")
    expect(talk).not.toContain("document.visibilityState === 'visible') {\n            void fetch")
  })
})
