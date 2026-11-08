/**
 * Client iPhone app, Step 2: the three routes under /api/portal/app/ (dev job 056a70d0).
 * The ORDER is the safety: switch first (nothing is read while it is off), then signed in, then who the person is for the app
 * (staff and partners are refused), then the body, then the write. The person always comes from the session, never from the body.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { isClientAllowedApiPath } from '@/lib/auth/client-api-allowlist'

const h = vi.hoisted(() => ({
  enabled: true,
  user: null as null | { id: string; email: string },
  loadResult: null as null | { ok: true; input: unknown } | { ok: false; status: number; code: string; error: string },
  audience: null as null | { ok: true } | { ok: false; status: number; code: string; error: string },
  order: [] as string[],
  barWrites: [] as Array<{ userId: string; keys: string[] }>,
  barClears: [] as string[],
  barResult: { ok: true } as { ok: true } | { ok: false },
  registered: [] as Array<{ userId: string; reg: Record<string, unknown> }>,
  removed: [] as Array<{ userId: string; token: string; bundleId: string }>,
  registerResult: { ok: true } as { ok: true } | { ok: false; code: string },
  readers: [] as Array<(name: string) => string | undefined>,
  loadThrows: false,
}))

vi.mock('@/lib/portal-app/enabled', () => ({
  CLIENT_APP_NOT_ENABLED: { error: 'The app is not switched on yet.', code: 'APP_NOT_ENABLED' },
  isClientAppEnabled: async () => { h.order.push('enabled'); return h.enabled },
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => { h.order.push('user'); return { data: { user: h.user } } } } }) }))
vi.mock('@/lib/portal-app/load', () => ({
  loadAppMeInput: async (_user: unknown, reader: (name: string) => string | undefined) => {
    h.order.push('load'); h.readers.push(reader)
    if (h.loadThrows) throw new Error('database went away')
    return h.loadResult
  },
  resolveAppAudience: async (_user: unknown, reader: (name: string) => string | undefined) => { h.order.push('audience'); h.readers.push(reader); return h.audience },
}))
vi.mock('@/lib/portal-app/bar-pref', () => ({
  setBarPref: async (userId: string, keys: string[]) => { h.order.push('bar-write'); h.barWrites.push({ userId, keys }); return h.barResult },
  clearBarPref: async (userId: string) => { h.order.push('bar-clear'); h.barClears.push(userId); return h.barResult },
}))
vi.mock('@/lib/app/devices', async importOriginal => {
  const real = await importOriginal<typeof import('@/lib/app/devices')>()
  return {
    ...real,
    registerDevice: async (userId: string, reg: Record<string, unknown>) => { h.order.push('register'); h.registered.push({ userId, reg }); return h.registerResult },
    removeDevice: async (userId: string, token: string, bundleId: string) => { h.order.push('remove'); h.removed.push({ userId, token, bundleId }); return { ok: true, removed: 1 } },
  }
})

import { GET } from '@/app/api/portal/app/me/route'
import { PUT as BAR_PUT, DELETE as BAR_DELETE } from '@/app/api/portal/app/bar/route'
import { PUT as DEV_PUT, DELETE as DEV_DELETE } from '@/app/api/portal/app/devices/route'

const SANDBOX_URL = 'https://xjcxlmlpeywtwkhstjlw.supabase.co'
const CLIENT_BUNDLE = 'com.tonydurante.myllcmanager.sandbox'
const STAFF_BUNDLE = 'com.tonydurante.tdsocial.sandbox'
const TOKEN = 'ab'.repeat(32)
const BASE = 'http://localhost/api/portal/app/x'
const req = (b: unknown, qs = '') => ({ url: BASE + qs, json: async () => b }) as never
const getReq = (qs = '') => ({ url: 'http://localhost/api/portal/app/me' + qs }) as never

// A minimal input the real assembler can turn into an answer (an active client with Chat, Documents and Sign Documents).
const input = {
  user: { name: 'Demo', email: 'demo@example.com' },
  kind: 'client',
  locale: 'en',
  t: (k: string) => k,
  ctx: { portalTier: 'active', hasCompany: true, navVisibility: { documents: true, pendingSignatures: true } },
  selection: { inProgress: [], inProgressOnboardings: [] },
  company: { id: 'a1', name: 'Demo Company LLC' },
  counts: { chat: 1, documents: 0, sign: 0, billing: 0 },
  savedBar: null,
  payEnabled: true,
}
const refusal = (code: string) => ({ ok: false as const, status: 403, code, error: 'no' })

beforeEach(() => {
  h.enabled = true; h.user = { id: 'u-client', email: 'c@x.y' }; h.loadResult = { ok: true, input }
  h.audience = { ok: true }; h.order = []; h.barWrites = []; h.barClears = []; h.barResult = { ok: true }
  h.registered = []; h.removed = []; h.registerResult = { ok: true }; h.readers = []; h.loadThrows = false
  process.env.NEXT_PUBLIC_SUPABASE_URL = SANDBOX_URL
})

describe('GET /api/portal/app/me', () => {
  it("answers 'not switched on' FIRST: nobody is looked up while the switch is off", async () => {
    h.enabled = false
    const res = await GET(getReq())
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('APP_NOT_ENABLED')
    expect(h.order).toEqual(['enabled'])
  })
  it('401 when nobody is signed in, and nothing else is read', async () => {
    h.user = null
    const res = await GET(getReq())
    expect(res.status).toBe(401)
    expect(h.order).toEqual(['enabled', 'user'])
  })
  it('refuses staff and partners with a plain answer', async () => {
    h.loadResult = refusal('NOT_FOR_PARTNERS')
    const res = await GET(getReq())
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('NOT_FOR_PARTNERS')
  })
  it('answers with the entries, the bar and the Menu number, never cached', async () => {
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(j.items.map((i: { key: string }) => i.key)).toContain('nav.chat')
    expect(j.lockedKey).toBe('nav.chat')
    expect(j.bar).toContain('nav.chat')
    expect(h.order).toEqual(['enabled', 'user', 'load'])
  })
})

describe('PUT / DELETE /api/portal/app/bar', () => {
  it('switch first, then signed in, then who the person is, then the list, then the write', async () => {
    const res = await BAR_PUT(req({ keys: ['nav.overview', 'nav.chat'] }))
    expect(res.status).toBe(200)
    expect(h.order).toEqual(['enabled', 'user', 'load', 'bar-write'])
    expect(h.barWrites).toEqual([{ userId: 'u-client', keys: ['nav.overview', 'nav.chat'] }])
    const j = await res.json()
    expect(j.bar).toEqual(['nav.overview', 'nav.chat'])
  })
  it('writes nothing while the switch is off or nobody is signed in', async () => {
    h.enabled = false
    expect((await BAR_PUT(req({ keys: ['nav.chat'] }))).status).toBe(503)
    h.enabled = true; h.user = null
    expect((await BAR_PUT(req({ keys: ['nav.chat'] }))).status).toBe(401)
    expect(h.barWrites).toEqual([])
  })
  it('refuses a staff login or a partner and writes nothing', async () => {
    h.loadResult = refusal('NOT_A_CLIENT')
    const res = await BAR_PUT(req({ keys: ['nav.chat'] }))
    expect(res.status).toBe(403)
    expect(h.barWrites).toEqual([])
  })
  it('refuses a bar without Chat, with something the person does not have, or that is not a list (400, nothing written)', async () => {
    const noChat = await BAR_PUT(req({ keys: ['nav.overview', 'nav.documents'] }))
    expect(noChat.status).toBe(400)
    expect((await noChat.json()).code).toBe('BAR_NEEDS_CHAT')
    const notMine = await BAR_PUT(req({ keys: ['nav.chat', 'nav.tdBilling'] }))
    expect((await notMine.json()).code).toBe('BAR_NOT_AVAILABLE')
    expect((await BAR_PUT(req({ keys: 'nav.chat' }))).status).toBe(400)
    expect((await BAR_PUT(req(null))).status).toBe(400)
    expect((await BAR_PUT({ url: BASE, json: async () => { throw new Error('bad json') } } as never)).status).toBe(400)
    expect(h.barWrites).toEqual([])
  })
  it('uses the person from the session, never one named in the body', async () => {
    await BAR_PUT(req({ keys: ['nav.chat'], userId: 'someone-else', user_id: 'someone-else' }))
    expect(h.barWrites[0].userId).toBe('u-client')
  })
  it('500 with a plain message when the save fails', async () => {
    h.barResult = { ok: false }
    const res = await BAR_PUT(req({ keys: ['nav.chat'] }))
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBe('SAVE_FAILED')
  })
  it('DELETE puts the standard bar back and answers with it (not the saved one)', async () => {
    h.loadResult = { ok: true, input: { ...input, savedBar: ['nav.chat'] } }
    const res = await BAR_DELETE(req(null))
    expect(res.status).toBe(200)
    expect(h.barClears).toEqual(['u-client'])
    const j = await res.json()
    expect(j.bar).toEqual(['nav.overview', 'nav.chat', 'nav.documents', 'nav.signDocuments'])
    expect(j.bar).not.toEqual(['nav.chat'])
  })
  it('a save keeps a choice for an entry this company cannot show (behind the new ones), and drops one it could show but the person left out', async () => {
    // TD Billing is not available here (no TD invoice in this company); Referrals is available here and was left out on purpose.
    h.loadResult = { ok: true, input: { ...input, savedBar: ['nav.overview', 'nav.chat', 'nav.tdBilling', 'nav.referrals', 'nav.documents'] } }
    const res = await BAR_PUT(req({ keys: ['nav.overview', 'nav.chat', 'nav.documents'] }))
    expect(res.status).toBe(200)
    expect(h.barWrites[0].keys).toEqual(['nav.overview', 'nav.chat', 'nav.documents', 'nav.tdBilling'])
  })
  it('DELETE writes nothing while the switch is off', async () => {
    h.enabled = false
    expect((await BAR_DELETE(req(null))).status).toBe(503)
    expect(h.barClears).toEqual([])
  })
})

describe('PUT / DELETE /api/portal/app/devices', () => {
  const good = { token: TOKEN, bundleId: CLIENT_BUNDLE, apnsEnv: 'production', deviceName: 'iPhone' }
  it('order: switch, signed in, who the person is, the server and bundle id, the body, the write', async () => {
    const res = await DEV_PUT(req(good))
    expect(res.status).toBe(200)
    expect(h.order).toEqual(['enabled', 'user', 'audience', 'register'])
    expect(h.registered[0].userId).toBe('u-client')
    expect(h.registered[0].reg).toMatchObject({ token: TOKEN, bundleId: CLIENT_BUNDLE })
  })
  it('refuses staff and partners before anything is saved', async () => {
    h.audience = refusal('NOT_FOR_PARTNERS')
    const res = await DEV_PUT(req(good))
    expect(res.status).toBe(403)
    expect(h.registered).toEqual([])
  })
  it("does not accept TD Social's bundle id: the staff app and the client app can never be mixed up", async () => {
    const res = await DEV_PUT(req({ ...good, bundleId: STAFF_BUNDLE }))
    expect(res.status).toBe(400)
    expect(h.registered).toEqual([])
  })
  it("does not accept the production id on the sandbox server", async () => {
    const res = await DEV_PUT(req({ ...good, bundleId: 'com.tonydurante.myllcmanager' }))
    expect(res.status).toBe(400)
  })
  it('refuses when the server cannot tell what it is (nothing accepted)', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://localhost'
    const res = await DEV_PUT(req(good))
    expect(res.status).toBe(503)
    expect(h.registered).toEqual([])
  })
  it('refuses a bad token, an address in place of the two-value Apple setting, and a broken body', async () => {
    expect((await DEV_PUT(req({ ...good, token: 'nothex' }))).status).toBe(400)
    expect((await DEV_PUT(req({ ...good, apnsEnv: 'https://api.push.apple.com' }))).status).toBe(400)
    expect((await DEV_PUT({ url: BASE, json: async () => { throw new Error('bad json') } } as never)).status).toBe(400)
    expect(h.registered).toEqual([])
  })
  it('409 at the phone limit, 500 on a database error', async () => {
    h.registerResult = { ok: false, code: 'TOO_MANY_DEVICES' }
    expect((await DEV_PUT(req(good))).status).toBe(409)
    h.registerResult = { ok: false, code: 'DB_ERROR' }
    expect((await DEV_PUT(req(good))).status).toBe(500)
  })
  it('removing needs no audience check (a person who lost access can still remove their own phone) but does need the switch and a session', async () => {
    h.audience = refusal('NOT_FOR_PARTNERS')
    const res = await DEV_DELETE(req({ token: TOKEN, bundleId: CLIENT_BUNDLE }))
    expect(res.status).toBe(200)
    expect(h.removed).toEqual([{ userId: 'u-client', token: TOKEN, bundleId: CLIENT_BUNDLE }])
    expect(h.order).not.toContain('audience')
    h.enabled = false
    expect((await DEV_DELETE(req({ token: TOKEN, bundleId: CLIENT_BUNDLE }))).status).toBe(503)
  })
})

describe('which company: the address says it, the website cookies never reach this path', () => {
  const ask = (reader: (name: string) => string | undefined) => ({
    account: reader('portal_account_id'), formation: reader('portal_formation'), onboarding: reader('portal_onboarding'), mode: reader('portal_mode'),
  })
  it('me, bar (save and reset) and phones pass ?account / ?formation / ?onboarding / ?mode to the loader', async () => {
    const qs = '?account=a2&formation=f1&onboarding=o1&mode=client'
    await GET(getReq(qs))
    await BAR_PUT(req({ keys: ['nav.chat'] }, qs))
    await BAR_DELETE(req(null, qs))
    await DEV_PUT(req({ token: TOKEN, bundleId: CLIENT_BUNDLE, apnsEnv: 'production' }, qs))
    expect(h.readers).toHaveLength(4)
    for (const r of h.readers) expect(ask(r)).toEqual({ account: 'a2', formation: 'f1', onboarding: 'o1', mode: 'client' })
  })
  it('says nothing when the address says nothing (then the first company answers, like the website)', async () => {
    await GET(getReq())
    expect(ask(h.readers[0])).toEqual({ account: undefined, formation: undefined, onboarding: undefined, mode: undefined })
  })
  it('ignores a very long or empty value and a broken address', async () => {
    await GET(getReq('?account=' + 'x'.repeat(200) + '&mode='))
    expect(ask(h.readers[0])).toMatchObject({ account: undefined, mode: undefined })
    await GET({ url: 'not a url' } as never)
    expect(ask(h.readers[1]).account).toBeUndefined()
  })
  it("the website's switcher writes its cookies for /portal only, so the app routes must not depend on them", () => {
    const sw = readFileSync('components/portal/company-switcher.tsx', 'utf8')
    const writes = sw.match(/document\.cookie = `portal_(account_id|formation|onboarding|mode)=[^`]*`/g) ?? []
    expect(writes.length).toBeGreaterThan(0)
    for (const w of writes) expect(w, w).toContain('path=/portal;')
    for (const f of ['gate.ts', 'load.ts']) expect(readFileSync(`lib/portal-app/${f}`, 'utf8'), f).not.toMatch(/from 'next\/headers'/)
  })
})

describe('a helper that throws becomes a plain JSON answer, not an empty 500', () => {
  it('me and bar', async () => {
    h.loadThrows = true
    const a = await GET(getReq())
    expect(a.status).toBe(500)
    expect((await a.json()).code).toBe('SERVER_ERROR')
    const b = await BAR_PUT(req({ keys: ['nav.chat'] }))
    expect(b.status).toBe(500)
    expect((await b.json()).code).toBe('SERVER_ERROR')
    expect(h.barWrites).toEqual([])
  })
})

describe('the folder is wired the way the other routes are', () => {
  it('every route starts with the shared door, and the client API allow-list lets clients reach the folder', () => {
    for (const f of ['me', 'bar', 'devices']) {
      const src = readFileSync(`app/api/portal/app/${f}/route.ts`, 'utf8')
      const gate = src.indexOf('await clientAppGate()')
      expect(gate, f).toBeGreaterThan(-1)
      // the door comes before any reading of the person or any write: compare with the first CALL of each (not the import line)
      for (const call of ['await loadAppMeInput(', 'await resolveAppAudience(', 'await setBarPref(', 'await clearBarPref(', 'await registerDevice(', 'await removeDevice(']) {
        const at = src.indexOf(call)
        if (at !== -1) expect(gate, `${f}: gate before ${call}`).toBeLessThan(at)
      }
      expect(src, f).toContain("export const dynamic = 'force-dynamic'")
    }
    for (const p of ['/api/portal/app/me', '/api/portal/app/bar', '/api/portal/app/devices']) expect(isClientAllowedApiPath(p), p).toBe(true)
  })
})
