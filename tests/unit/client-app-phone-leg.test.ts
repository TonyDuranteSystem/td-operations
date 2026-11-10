/**
 * Client iPhone app, Step 4 (dev job 056a70d0): alerts to clients' and team members' phones.
 * The wording, who may be told, the sender (with a fake Apple), the doorway, the two web senders' hook, and the phone's owner at registration.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const { liveSend, webSend, upsertCalls } = vi.hoisted(() => ({ liveSend: vi.fn(), webSend: vi.fn(), upsertCalls: [] as Array<Record<string, unknown>> }))

// only the live entry point is replaced (the doorway and the two web senders reach it); the pure parts below are the real ones
vi.mock('@/lib/portal-app/send-to-client-phones', async () => ({ ...(await vi.importActual<typeof import('@/lib/portal-app/send-to-client-phones')>('@/lib/portal-app/send-to-client-phones')), sendToClientPhonesLive: liveSend }))
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: webSend } }))
vi.mock('@/lib/app/phone-leg', async () => ({ ...(await vi.importActual<typeof import('@/lib/app/phone-leg')>('@/lib/app/phone-leg')), startPhoneLeg: vi.fn(async () => undefined) }))
vi.mock('@/lib/supabase-admin', () => {
  const rows = [{ id: 's1', endpoint: 'https://push.example/1', p256dh: 'p', auth_key: 'a' }]
  const chain = () => {
    const c: Record<string, unknown> = {}
    for (const k of ['eq', 'neq', 'in', 'is', 'gte', 'limit', 'order']) c[k] = () => c
    c.then = (resolve: (v: { data: typeof rows; error: null; count: number }) => void) => resolve({ data: rows, error: null, count: 0 })
    return c
  }
  return { supabaseAdmin: { from: () => ({
    select: () => chain(),
    delete: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
    upsert: (row: Record<string, unknown>) => { upsertCalls.push(row); return Promise.resolve({ error: null }) },
  }) } }
})

import { clientAlertKind, clientPhoneWording, type ClientAlertKind } from '@/lib/portal-app/phone-wording'
import { startClientPhoneLeg, type ClientPhoneAlert } from '@/lib/portal-app/client-phone-leg'
import { sendToClientPhones, selectRecipientPhones, type ClientPhoneDeps, type ClientPhoneRow, type OwnedDevice, MAX_PHONES } from '@/lib/portal-app/send-to-client-phones'
import { registerDevice, type DeviceRegistration } from '@/lib/app/devices'
import type { ApnsKey } from '@/lib/app/apns-key'
import type { ApnsRequest } from '@/lib/app/apns'

const ROOT = path.resolve(__dirname, '../..')
const src = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const KEYS = ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_PRIVATE_KEY'] as const

describe('what a lock screen may show', () => {
  it('maps the notification types our code uses to a closed list of kinds, anything else is generic', () => {
    const cases: Array<[string, ClientAlertKind]> = [['chat', 'chat'], ['reaction', 'reaction'], ['service', 'service'], ['formation', 'service'], ['new_document', 'document'], ['document_uploaded', 'document'],
      ['document', 'document'], ['sign_document', 'sign'], ['signature_request', 'sign'], ['invoice', 'invoice'], ['decision', 'decision'], ['wizard_reminder', 'reminder'], ['test', 'test']]
    for (const [type, kind] of cases) expect(clientAlertKind(type), type).toBe(kind)
    for (const v of ['info', 'anything', '', 'toString', '__proto__', 'constructor', undefined, null, 5, {}]) expect(clientAlertKind(v), String(v)).toBe('generic')
  })

  it('says who and what kind, in English or Italian, and never carries a typed word', () => {
    expect(clientPhoneWording('chat', 'en')).toEqual({ title: 'New message from Tony Durante LLC', body: '' })
    expect(clientPhoneWording('chat', 'it')).toEqual({ title: 'Nuovo messaggio da Tony Durante LLC', body: '' })
    expect(clientPhoneWording('sign', 'en').title).toBe('A document needs your signature')
    expect(clientPhoneWording('invoice', 'it').title).toBe('Nuova fattura da Tony Durante LLC')
    const all: ClientAlertKind[] = ['chat', 'reaction', 'service', 'document', 'sign', 'invoice', 'decision', 'reminder', 'generic', 'test']
    for (const k of all) for (const l of ['en', 'it'] as const) {
      const w = clientPhoneWording(k, l)
      expect(w.title.length, `${k} ${l}`).toBeGreaterThan(0)
      expect(w.title + w.body).not.toMatch(/[$€]|\d/) // never an amount or a number
    }
    // every kind except the system test has an empty body: nothing but the headline reaches a lock screen
    for (const k of all.filter(x => x !== 'test')) expect(clientPhoneWording(k, 'en').body).toBe('')
  })
})

describe('who may be told (selectRecipientPhones)', () => {
  const dev = (over: Partial<OwnedDevice>): OwnedDevice => ({ id: 'd', user_id: 'u', token: 't', bundle_id: 'b', apns_env: 'development', contact_id: null, team_account_id: null, ...over })

  it('contact scope: only the phones of that contact', () => {
    const rows = [dev({ id: 'a', contact_id: 'c1' }), dev({ id: 'b', contact_id: 'c2' }), dev({ id: 'c', team_account_id: 'acct' }), dev({ id: 'd' })]
    expect(selectRecipientPhones(rows, { scope: 'contact', id: 'c1', linkedContactIds: new Set(), activeTeamUserIds: new Set() }).map(r => r.id)).toEqual(['a'])
  })

  it('account scope: contacts linked to the company right now, and active team members of that company with chat', () => {
    const rows = [
      dev({ id: 'linked', contact_id: 'c1' }),
      dev({ id: 'unlinked', contact_id: 'c2' }),
      dev({ id: 'team-ok', user_id: 'tm1', team_account_id: 'acct' }),
      dev({ id: 'team-removed', user_id: 'tm2', team_account_id: 'acct' }),
      dev({ id: 'team-other-company', user_id: 'tm1', team_account_id: 'other' }),
      dev({ id: 'no-owner' }),
    ]
    const ids = selectRecipientPhones(rows, { scope: 'account', id: 'acct', linkedContactIds: new Set(['c1']), activeTeamUserIds: new Set(['tm1']) }).map(r => r.id)
    expect(ids).toEqual(['linked', 'team-ok'])
  })

  it('any doubt is nobody: no links known, no phones with an owner', () => {
    const rows = [dev({ id: 'x', contact_id: 'c1' }), dev({ id: 'y', team_account_id: 'acct', user_id: 'tm' })]
    expect(selectRecipientPhones(rows, { scope: 'account', id: 'acct', linkedContactIds: new Set(), activeTeamUserIds: new Set() })).toEqual([])
    expect(selectRecipientPhones([dev({})], { scope: 'account', id: 'acct', linkedContactIds: new Set(['c1']), activeTeamUserIds: new Set(['u']) })).toEqual([])
  })
})

// ---- the sender, against a fake Apple --------------------------------------------------------------------------------------------------------------------------
const BUNDLE = 'com.tonydurante.myllcmanager.sandbox'
const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const KEY: ApnsKey = { keyId: 'ABCDE12345', teamId: 'FGHIJ67890', privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
const ALERT: ClientPhoneAlert = { scope: 'contact', id: 'c1', kind: 'chat', url: '/portal/chat/open?topic=x', tag: 'chat' }
const phone = (over: Partial<ClientPhoneRow> = {}): ClientPhoneRow => ({ id: 'p1', user_id: 'u1', token: 'a'.repeat(64), bundle_id: BUNDLE, apns_env: 'development', contact_id: 'c1', team_account_id: null, locale: 'en', ...over })

function deps(over: Partial<ClientPhoneDeps> = {}, answer: { status: number; reason: string | null } = { status: 200, reason: null }) {
  const sent: ApnsRequest[] = []
  const revoked: Array<[string, string]> = []
  const logs: string[] = []
  const d: ClientPhoneDeps = {
    key: KEY, isOn: async () => true, bundleId: BUNDLE,
    phones: vi.fn(async () => [phone()]), badge: vi.fn(async () => 3),
    connect: () => ({ send: async req => { sent.push(req); return answer }, close: () => undefined }),
    revoke: async (id, reason) => { revoked.push([id, reason]) }, now: () => Date.UTC(2026, 10, 10), log: m => { logs.push(m) },
    ...over,
  }
  return { d, sent, revoked, logs }
}

describe('sendToClientPhones', () => {
  it('ends quietly, and reads nothing, with no key / the switch off / an unknown server', async () => {
    for (const [name, over, why] of [['key', { key: null }, 'no key'], ['switch', { isOn: async () => false }, 'switched off'], ['server', { bundleId: null }, 'unknown server']] as const) {
      const x = deps(over)
      const r = await sendToClientPhones(ALERT, x.d)
      expect(r.skipped, name).toBe(why)
      expect(x.d.phones).not.toHaveBeenCalled()
      expect(x.sent).toEqual([])
    }
  })

  it('no phones = nothing sent', async () => {
    const x = deps({ phones: async () => [] })
    expect((await sendToClientPhones(ALERT, x.d)).skipped).toBe('no phones')
  })

  it('sends the fixed words for the kind, in the person\'s language, to the client bundle, with the icon number and a safe link', async () => {
    const x = deps({ phones: async () => [phone(), phone({ id: 'p2', token: 'b'.repeat(64), locale: 'it', user_id: 'u2' })] })
    const r = await sendToClientPhones(ALERT, x.d)
    expect(r).toMatchObject({ attempted: 2, sent: 2, failed: 0, gone: 0 })
    const bodies = x.sent.map(s => JSON.parse(s.body))
    expect(bodies.map(b => b.aps.alert.title)).toEqual(['New message from Tony Durante LLC', 'Nuovo messaggio da Tony Durante LLC'])
    expect(bodies[0].aps.badge).toBe(3)
    expect(bodies[0].url).toBe('/portal/chat/open?topic=x')
    for (const s of x.sent) expect(s.headers['apns-topic']).toBe(BUNDLE)
    expect(x.sent[0].path).toBe(`/3/device/${'a'.repeat(64)}`)
  })

  it('an alert has no title or body to leak: only the kind decides the words, an unknown type is generic', async () => {
    const x = deps()
    await sendToClientPhones({ ...ALERT, kind: 'something we never listed', url: 'https://evil.example/x' }, x.d)
    const b = JSON.parse(x.sent[0].body)
    expect(b.aps.alert.title).toBe('New notification from Tony Durante LLC')
    expect(b.url).toBeUndefined() // a link to another site is never sent
    expect(Object.keys(ALERT)).not.toContain('title')
    expect(Object.keys(ALERT)).not.toContain('body')
  })

  it('an unknown icon number goes without one (the phone keeps its own)', async () => {
    const x = deps({ badge: async () => null })
    await sendToClientPhones(ALERT, x.d)
    expect(JSON.parse(x.sent[0].body).aps.badge).toBeUndefined()
  })

  it('a phone of another bundle id is never sent to', async () => {
    const x = deps({ phones: async () => [phone({ bundle_id: 'com.tonydurante.tdsocial.sandbox' })] })
    expect((await sendToClientPhones(ALERT, x.d)).skipped).toBe('no phones')
  })

  it('removes a phone only when Apple says it is gone', async () => {
    const gone = deps({}, { status: 410, reason: 'Unregistered' })
    expect(await sendToClientPhones(ALERT, gone.d)).toMatchObject({ gone: 1, sent: 0 })
    expect(gone.revoked).toEqual([['p1', 'apple_Unregistered']])
  })

  it('Apple refusing the key (403) or asking to slow down (429) stops that address and removes NOTHING', async () => {
    for (const status of [403, 429]) {
      const x = deps({ phones: async () => [phone(), phone({ id: 'p2', token: 'c'.repeat(64) })] }, { status, reason: 'InvalidProviderToken' })
      const r = await sendToClientPhones(ALERT, x.d)
      expect(r.stopped).toBe(true)
      expect(r.gone).toBe(0)
      expect(x.revoked).toEqual([])
    }
  })

  it('a connection that throws never rejects and removes nothing', async () => {
    const x = deps({ connect: () => ({ send: async () => { throw new Error('boom') }, close: () => undefined }) })
    const r = await sendToClientPhones(ALERT, x.d)
    expect(r).toMatchObject({ sent: 0, failed: 1, gone: 0 })
    expect(x.revoked).toEqual([])
  })

  it('never sends to more phones than the cap', async () => {
    const many = Array.from({ length: MAX_PHONES + 15 }, (_, i) => phone({ id: `p${i}`, token: i.toString(16).padStart(64, '0') }))
    const x = deps({ phones: async () => many })
    expect((await sendToClientPhones(ALERT, x.d)).attempted).toBe(MAX_PHONES)
  })
})

describe('the doorway', () => {
  beforeEach(() => { liveSend.mockReset(); for (const k of KEYS) delete process.env[k] })
  afterEach(() => { for (const k of KEYS) delete process.env[k]; vi.restoreAllMocks() })

  it('no Apple key: returns at once, the heavy sender is never loaded or called', async () => {
    await expect(startClientPhoneLeg(ALERT)).resolves.toBeUndefined()
    expect(liveSend).not.toHaveBeenCalled()
  })

  it('the key set: the alert is handed over exactly as given', async () => {
    process.env.APNS_KEY_ID = 'x'; process.env.APNS_TEAM_ID = 'y'; process.env.APNS_PRIVATE_KEY = 'z'
    liveSend.mockResolvedValue({ attempted: 0, sent: 0, gone: 0, failed: 0, stopped: false })
    await startClientPhoneLeg(ALERT)
    expect(liveSend).toHaveBeenCalledWith(ALERT)
  })

  it('a sender that throws never makes the leg reject, and nothing it throws is logged', async () => {
    process.env.APNS_KEY_ID = 'x'; process.env.APNS_TEAM_ID = 'y'; process.env.APNS_PRIVATE_KEY = 'z'
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    liveSend.mockRejectedValue(new Error('boom with a secret: EIN 12-3456789'))
    await expect(startClientPhoneLeg(ALERT)).resolves.toBeUndefined()
    expect(JSON.stringify(err.mock.calls)).not.toContain('EIN')
  })

  it('an alert with no target is dropped before anything is loaded', async () => {
    process.env.APNS_KEY_ID = 'x'; process.env.APNS_TEAM_ID = 'y'; process.env.APNS_PRIVATE_KEY = 'z'
    await startClientPhoneLeg({ ...ALERT, id: '' })
    expect(liveSend).not.toHaveBeenCalled()
  })
})

describe('the two web senders', () => {
  beforeEach(() => { webSend.mockReset(); webSend.mockResolvedValue({}); process.env.VAPID_PUBLIC_KEY = 'pub'; process.env.VAPID_PRIVATE_KEY = 'priv'; liveSend.mockReset() })
  afterEach(() => { delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; for (const k of KEYS) delete process.env[k] })

  it('start the phone leg for the company / the person, and the browser never sees the kind', async () => {
    process.env.APNS_KEY_ID = 'x'; process.env.APNS_TEAM_ID = 'y'; process.env.APNS_PRIVATE_KEY = 'z'
    liveSend.mockResolvedValue({ attempted: 0, sent: 0, gone: 0, failed: 0, stopped: false })
    const { sendPushToAccount, sendPushToContact } = await import('@/lib/portal/web-push')
    await sendPushToAccount('acct-1', { title: 'T', body: 'B', url: '/portal/invoices', tag: 'invoice', clientKind: 'invoice' })
    expect(liveSend).toHaveBeenLastCalledWith({ scope: 'account', id: 'acct-1', kind: 'invoice', url: '/portal/invoices', tag: 'invoice' })
    await sendPushToContact('contact-1', { title: 'T', body: 'B', url: '/portal/chat', tag: 'chat', clientKind: 'chat' })
    expect(liveSend).toHaveBeenLastCalledWith({ scope: 'contact', id: 'contact-1', kind: 'chat', url: '/portal/chat', tag: 'chat' })
    expect(webSend).toHaveBeenCalledTimes(2)
    for (const call of webSend.mock.calls) expect(String(call[1])).not.toContain('clientKind')
  })

  it('without the Apple key nothing about phones runs and the web send is what it was', async () => {
    const { sendPushToAccount } = await import('@/lib/portal/web-push')
    const r = await sendPushToAccount('acct-1', { title: 'T', body: 'B', clientKind: 'chat' })
    expect(liveSend).not.toHaveBeenCalled()
    expect(r).toEqual({ sent: 1, failed: 0 })
  })

  it('a phone leg that fails or never answers cannot fail or hold up the web send', async () => {
    process.env.APNS_KEY_ID = 'x'; process.env.APNS_TEAM_ID = 'y'; process.env.APNS_PRIVATE_KEY = 'z'
    liveSend.mockRejectedValue(new Error('apple is down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { sendPushToContact } = await import('@/lib/portal/web-push')
    await expect(sendPushToContact('contact-1', { title: 'T', body: 'B', clientKind: 'chat' })).resolves.toEqual({ sent: 1, failed: 0 })
  })

  it('every client alert caller names its kind (the notification type, the service update, the test)', () => {
    expect(src('lib/portal/notifications.ts').match(/clientKind: params\.type/g)?.length).toBe(2)
    expect(src('lib/service-delivery.ts')).toContain('clientKind: "service"')
    expect(src('app/api/portal/push/test/route.ts')).toContain("clientKind: 'test'")
  })
})

describe('the phone remembers its owner', () => {
  const reg: DeviceRegistration = { token: 'a'.repeat(64), bundleId: BUNDLE, apnsEnv: 'development', deviceName: 'iPhone', appVersion: '2.0', appBuild: 1 }
  beforeEach(() => { upsertCalls.length = 0 })

  it('a client phone is saved with its contact and no company, a team member phone with its company and no contact', async () => {
    expect(await registerDevice('u1', reg, new Date(), { contactId: 'c1' })).toEqual({ ok: true })
    expect(upsertCalls[0]).toMatchObject({ contact_id: 'c1', team_account_id: null })
    await registerDevice('u2', reg, new Date(), { teamAccountId: 'acct-9' })
    expect(upsertCalls[1]).toMatchObject({ contact_id: null, team_account_id: 'acct-9' })
  })

  it('a TD Social (staff) phone writes neither column, so it works even before the database file has been run', async () => {
    await registerDevice('u3', { ...reg, bundleId: 'com.tonydurante.tdsocial.sandbox' })
    expect(Object.keys(upsertCalls[0])).not.toContain('contact_id')
    expect(Object.keys(upsertCalls[0])).not.toContain('team_account_id')
  })
})

describe('the database file', () => {
  it('adds two optional columns and two partial indexes, safe to run twice, with an undo', () => {
    const up = src('scripts/migrations/20261110-0100-client-app-phone-owner.sql')
    expect(up).toContain('ADD COLUMN IF NOT EXISTS contact_id uuid')
    expect(up).toContain('ADD COLUMN IF NOT EXISTS team_account_id uuid')
    expect(up).toContain('CREATE INDEX IF NOT EXISTS social_app_devices_contact_idx')
    expect(up).toContain('CREATE INDEX IF NOT EXISTS social_app_devices_team_account_idx')
    expect(up).not.toMatch(/REFERENCES|NOT NULL DEFAULT|DROP /i)
    const down = src('scripts/migrations/20261110-0100-client-app-phone-owner.UNDO.sql')
    expect(down).toContain('DROP COLUMN IF EXISTS contact_id')
    expect(down).toContain('DROP COLUMN IF EXISTS team_account_id')
  })
})
