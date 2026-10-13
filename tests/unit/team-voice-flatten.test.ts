/**
 * One-time repair of voice notes already stored as the fragmented MP4 Safari plays badly (dev job c1e326dd): the pure helpers,
 * the route against a fake database + fake storage, and source guards for the page wiring.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { build } from './helpers-fmp4'
import { teamChatAudioPath, backupPathFor } from '@/lib/team/voice-flatten'
import { looksFragmented, fragmentedMp4ToFlat } from '@/lib/media/fmp4-to-flat'

const SB = 'https://p.supabase.co'
const T = '91628ee8-3852-41b2-bd30-a1238ccc0b10'
const F = '0e4a1adf-daa7-4615-a6ed-ae7ea5558ca6'
const urlFor = (path: string) => `${SB}/storage/v1/object/public/assets/${path}`

const frag = build({ frags: [{ sizes: [100, 100, 100], durations: [1024, 1024, 1024], seed: 3 }, { sizes: [90], durations: [1024], seed: 4 }] }).file
const flatFile = fragmentedMp4ToFlat(frag)!.data

describe('pure helpers', () => {
  it('only accepts OUR team-chat audio files, and keeps the original under a separate folder', () => {
    expect(teamChatAudioPath(urlFor(`team-chat/${T}/${F}.m4a`), SB)).toBe(`team-chat/${T}/${F}.m4a`)
    expect(teamChatAudioPath(urlFor(`team-chat/${T}/${F}.m4a`) + '?v=1', SB)).toBe(`team-chat/${T}/${F}.m4a`)
    expect(teamChatAudioPath(urlFor(`other/${T}/${F}.m4a`), SB)).toBeNull()
    expect(teamChatAudioPath(urlFor(`team-chat/${T}/../x.m4a`), SB)).toBeNull()
    expect(teamChatAudioPath(urlFor(`team-chat/${T}/${F}.exe`), SB)).toBeNull()
    expect(teamChatAudioPath(`https://evil.com/storage/v1/object/public/assets/team-chat/${T}/${F}.m4a`, SB)).toBeNull()
    expect(teamChatAudioPath(urlFor(`team-chat/${T}/${F}.m4a`), undefined)).toBeNull()
    expect(backupPathFor(`team-chat/${T}/${F}.m4a`)).toBe(`team-chat-originals/${T}/${F}.m4a`)
  })
  it('tells the fragmented kind from an ordinary file by its first bytes', () => {
    expect(looksFragmented(frag.slice(0, 8192))).toBe(true)
    expect(looksFragmented(fragmentedMp4ToFlat(frag)!.data.slice(0, 8192))).toBe(false) // an ordinary file has no movie-extends box
    expect(looksFragmented(new Uint8Array([1, 2, 3]))).toBe(false)
  })
})

type Row = Record<string, unknown>
const h = vi.hoisted(() => ({
  user: { id: 'me' } as Record<string, unknown> | null,
  messages: [] as Row[], threads: [] as Row[], members: [] as string[],
  uploads: [] as Array<{ path: string; bytes: Uint8Array; opts: Record<string, unknown> }>,
  existing: new Set<string>(), failUpload: '' as string,
  files: new Map<string, Uint8Array>(),
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
      let id: unknown; let patch: Row | null = null
      const api: Record<string, unknown> = {
        select: () => api, eq: (_c: string, v: unknown) => { id = v; return api }, update: (p: Row) => { patch = p; return api },
        maybeSingle: async () => ({ data: (table === 'internal_messages' ? h.messages : h.threads).find(r => r.id === id) ?? null }),
        then: (res: (v: unknown) => void) => { if (patch) { const m = h.messages.find(r => r.id === id); if (m) Object.assign(m, patch) } res({ data: null }) },
      }
      return api
    },
    storage: { from: () => ({
      upload: async (path: string, bytes: Uint8Array, opts: Record<string, unknown>) => {
        if (h.failUpload && path.includes(h.failUpload)) return { error: { message: 'boom' } }
        if (opts.upsert === false && h.existing.has(path)) return { error: { message: 'The resource already exists' } }
        h.uploads.push({ path, bytes, opts }); h.files.set(path, bytes); return { error: null }
      },
    }) },
  },
}))

import { POST } from '@/app/api/team/messages/[id]/flatten/route'

const MSG = '11111111-1111-1111-1111-111111111111'
const path = `team-chat/${T}/${F}.m4a`
const call = (body: unknown, id = MSG) => POST(new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) }) as never, { params: Promise.resolve({ id }) })
const att = (o: Row = {}) => ({ url: urlFor(path), name: 'voice-note.m4a', mime_type: 'audio/mp4', size: 999, ...o })

describe('POST /api/team/messages/[id]/flatten', () => {
  beforeEach(() => {
    h.user = { id: 'me' }; h.uploads = []; h.existing = new Set(); h.failUpload = ''; h.members = ['me', 'luca']; h.files = new Map()
    h.threads = [{ id: 't1', thread_type: 'dm', dm_key: 'me:luca' }, { id: 'g1', thread_type: 'group' }]
    h.messages = [{ id: MSG, thread_id: 't1', deleted_at: null, attachments: [att()] }]
    process.env.NEXT_PUBLIC_SUPABASE_URL = SB
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: { headers?: Record<string, string> }) => {
      const bytes = (h.files.get(path) ?? frag)
      const range = init?.headers?.Range
      return new Response(range ? bytes.slice(0, 8192) : bytes, { status: 200 })
    }))
  })
  const stored = () => (h.messages[0].attachments as Row[])[0]

  it('converts a fragmented note in place: keeps the original, replaces the file, marks the attachment', async () => {
    const r = await call({ index: 0 })
    const d = await r.json()
    expect(r.status).toBe(200); expect(d.ok).toBe(true); expect(typeof d.flattened_at).toBe('string')
    expect(h.uploads.map(u => u.path)).toEqual([`team-chat-originals/${T}/${F}.m4a`, path]) // backup FIRST, then the replacement
    expect(Array.from(h.uploads[0].bytes)).toEqual(Array.from(frag)) // the backup is the untouched original
    expect(h.uploads[1].opts.upsert).toBe(true)
    expect(find(h.uploads[1].bytes, 'moof')).toBe(-1) // the stored replacement is an ordinary MP4
    expect(stored()).toMatchObject({ flat: true, size: h.uploads[1].bytes.length })
    expect(stored().flattened_at).toBe(d.flattened_at)
  })
  it('only marks a note that is already an ordinary file, and never asks twice', async () => {
    h.files.set(path, flatFile)
    const d = await (await call({ index: 0 })).json()
    expect(d).toMatchObject({ ok: true, already: true })
    expect(h.uploads.length).toBe(0)
    expect(stored().flat).toBe(true)
    h.uploads = []
    expect((await (await call({ index: 0 })).json()).already).toBe(true)
    expect(h.uploads.length).toBe(0)
  })
  it('leaves an unusual file exactly as it is and stops checking it', async () => {
    h.files.set(path, build({ frags: [{ sizes: [60], seed: 9 }] }).file) // fragmented but no durations anywhere
    const d = await (await call({ index: 0 })).json()
    expect(d.ok).toBe(false)
    expect(h.uploads.length).toBe(0)
    expect(stored()).toMatchObject({ flat: true, flatten_failed: true })
  })
  it('changes nothing if the backup cannot be kept, or if the replacement fails', async () => {
    h.failUpload = 'team-chat-originals'
    expect((await call({ index: 0 })).status).toBe(500)
    expect(h.uploads.length).toBe(0); expect(stored().flat).toBeUndefined()
    h.failUpload = `/${F}.m4a`; h.existing = new Set([`team-chat-originals/${T}/${F}.m4a`]) // a backup already there is fine, but the replacement fails
    h.failUpload = `team-chat/${T}`
    const r = await call({ index: 0 })
    expect(r.status).toBe(500); expect(stored().flat).toBeUndefined()
  })
  it("refuses someone else's direct message, a group the caller is not in, another host, a path we did not create, and a non-voice attachment", async () => {
    h.user = { id: 'stranger' }
    expect((await call({ index: 0 })).status).toBe(403)
    h.user = { id: 'me' }; h.members = ['other']
    h.messages.push({ id: '22222222-2222-2222-2222-222222222222', thread_id: 'g1', deleted_at: null, attachments: [att()] })
    expect((await call({ index: 0 }, '22222222-2222-2222-2222-222222222222')).status).toBe(403)
    h.messages.push({ id: '33333333-3333-3333-3333-333333333333', thread_id: 't1', deleted_at: null, attachments: [att({ url: 'https://evil.com/a.m4a' })] })
    expect((await call({ index: 0 }, '33333333-3333-3333-3333-333333333333')).status).toBe(400)
    h.messages.push({ id: '44444444-4444-4444-4444-444444444444', thread_id: 't1', deleted_at: null, attachments: [att({ url: urlFor('other/x/y.m4a') })] })
    expect((await call({ index: 0 }, '44444444-4444-4444-4444-444444444444')).status).toBe(400)
    h.messages.push({ id: '55555555-5555-5555-5555-555555555555', thread_id: 't1', deleted_at: null, attachments: [att({ mime_type: 'image/png', name: 'a.png' })] })
    expect((await call({ index: 0 }, '55555555-5555-5555-5555-555555555555')).status).toBe(400)
    expect(h.uploads.length).toBe(0)
  })
})

function find(d: Uint8Array, type: string): number {
  const t = new TextEncoder().encode(type)
  outer: for (let i = 0; i + 4 <= d.length; i++) { for (let k = 0; k < 4; k++) if (d[i + k] !== t[k]) continue outer; return i }
  return -1
}

describe('wiring guards', () => {
  const read = (p: string) => readFileSync(join(__dirname, '../../', p), 'utf8')
  it('the shared voice note asks the server once per note and reloads the audio after a repair; both screens pass the marker', () => {
    const v = read('components/team-chat/voice-note.tsx')
    expect(v).toContain('/flatten')
    expect(v).toContain('repairAsked')
    expect(v).toContain('<audio key={src}')
    expect(read('components/talk/talk-messages.tsx')).toContain('flat={a.flat}')
    expect(read('app/(dashboard)/team-chat/page.tsx')).toContain('flat={(a as ChatAttachment).flat}')
  })
})
