import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Client iPhone app: the fixes after the bug hunt of 10 Nov 2026 (dev job 056a70d0; docs/systems/client-app.md → "Bug-hunt fixes").
// The iPhone-side rules are tested in ios/TDClient (`swift test`); everything here is the website / server side.

const rpc = vi.hoisted(() => vi.fn())
const getUserById = vi.hoisted(() => vi.fn())
const headersMock = vi.hoisted(() => vi.fn())
const enabledMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { rpc, auth: { admin: { getUserById } }, from: vi.fn() } }))
vi.mock('next/headers', () => ({ headers: headersMock }))
vi.mock('@/lib/portal-app/enabled', () => ({ isClientAppEnabled: enabledMock, isClientAppPayEnabled: vi.fn(async () => true), CLIENT_APP_NOT_ENABLED: {} }))

import { mayTestPushForAccount } from '@/lib/portal/push-test-access'
import { isCurrentLink, loginIsBanned, liveBannedUserIds } from '@/lib/portal-app/phone-people'
import { getClientAppModeActive } from '@/lib/app-mode/server'
import { MAX_FETCH, MAX_PHONES } from '@/lib/portal-app/send-to-client-phones'

const root = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

describe('finding 3: the app mode follows the switch', () => {
  beforeEach(() => { headersMock.mockReset(); enabledMock.mockReset() })

  it('is on only when the app says so in its browser name AND the switch is on', async () => {
    headersMock.mockReturnValue({ get: () => `${iphone} TDClient/2.0.0` })
    enabledMock.mockResolvedValue(true)
    expect(await getClientAppModeActive()).toBe(true)
  })

  it('is OFF when the switch is off, so the phone shows the normal website with its own menu and sign-out', async () => {
    headersMock.mockReturnValue({ get: () => `${iphone} TDClient/2.0.0` })
    enabledMock.mockResolvedValue(false)
    expect(await getClientAppModeActive()).toBe(false)
  })

  it('never reads the switch for a normal browser', async () => {
    headersMock.mockReturnValue({ get: () => iphone })
    expect(await getClientAppModeActive()).toBe(false)
    expect(enabledMock).not.toHaveBeenCalled()
  })

  it('is used by every portal page that draws app-only things (none still asks the browser name alone)', () => {
    for (const f of ['app/portal/layout.tsx', 'app/portal/offer/page.tsx', 'app/portal/chat/page.tsx', 'app/portal/invoices/page.tsx', 'app/portal/billing/page.tsx', 'app/portal/page.tsx']) {
      const src = read(f)
      expect(src, f).toContain('getClientAppModeActive')
      expect(src, f).not.toMatch(/getClientAppMode\(\)/)
    }
  })
})

describe('finding 2: the Pay switch covers the Overview "View Offer" banner', () => {
  it('draws the banner only when the app is not in app mode with Pay switched off', () => {
    const page = read('app/portal/page.tsx')
    expect(page).toContain('const offerHiddenInApp = pendingOffer ? (await getClientAppModeActive()) && !(await isClientAppPayEnabled()) : false')
    expect(page).toContain('{pendingOffer && !offerHiddenInApp && (')
  })
})

describe('finding 1: the page tells the app which company it shows', () => {
  it('posts the selection to the app, and the app door still honours only the person\'s own companies', () => {
    const frame = read('components/portal/client-app-frame.tsx')
    expect(frame).toMatch(/postMessage\(`selection:\$\{selectionQuery\}`\)/)
    expect(read('lib/portal-app/gate.ts')).toContain('resolveSelectedEntity')
  })
})

describe('finding 8: who may send a test alert to a company', () => {
  const contact = { kind: 'contact', contactId: 'c1', accountIds: ['a1', 'a2'] } as const
  const team = { kind: 'teammate', teamMemberId: 't1', accountId: 'a1', displayName: 'T', email: null, capabilities: {} } as never
  it('lets a client test their own companies and refuses a company they are not linked to', () => {
    expect(mayTestPushForAccount(contact, 'a2')).toBe(true)
    expect(mayTestPushForAccount(contact, 'zzz')).toBe(false)
  })
  it('lets a team member test only the one company they belong to', () => {
    expect(mayTestPushForAccount(team, 'a1')).toBe(true)
    expect(mayTestPushForAccount(team, 'a2')).toBe(false)
  })
  it('refuses every other kind of login, and anything that is not a plain company id', () => {
    expect(mayTestPushForAccount({ kind: 'none' }, 'a1')).toBe(false)
    expect(mayTestPushForAccount(contact, undefined)).toBe(false)
    expect(mayTestPushForAccount(contact, '')).toBe(false)
    expect(mayTestPushForAccount(contact, 42)).toBe(false)
    expect(mayTestPushForAccount(contact, 'a'.repeat(65))).toBe(false)
  })
  it('is what the route uses (a login with no client record is no longer waved through)', () => {
    const route = read('app/api/portal/push/test/route.ts')
    expect(route).toContain('mayTestPushForAccount(identity, account_id)')
    expect(route).not.toContain('contactId && account_id')
  })
})

describe('finding 10: phone alerts check the people behind saved phones', () => {
  const now = Date.parse('2026-11-10T12:00:00Z')
  it('a link that ended, had its access revoked or is past its end date is not "linked right now"', () => {
    expect(isCurrentLink({ contact_id: 'c1' }, now)).toBe(true)
    expect(isCurrentLink({ contact_id: 'c1', ended_at: null, access_revoked_at: null, access_until: null }, now)).toBe(true)
    expect(isCurrentLink({ contact_id: 'c1', ended_at: '2026-10-01T00:00:00Z' }, now)).toBe(false)
    expect(isCurrentLink({ contact_id: 'c1', access_revoked_at: '2026-10-01T00:00:00Z' }, now)).toBe(false)
    expect(isCurrentLink({ contact_id: 'c1', access_until: '2026-11-01T00:00:00Z' }, now)).toBe(false)
    expect(isCurrentLink({ contact_id: 'c1', access_until: '2026-12-01T00:00:00Z' }, now)).toBe(true)
    expect(isCurrentLink({ contact_id: null }, now)).toBe(false)
  })
  it('a login banned into the future is suspended; no value or a past value is not', () => {
    expect(loginIsBanned('2126-11-10T00:00:00Z', now)).toBe(true)
    expect(loginIsBanned('2026-01-01T00:00:00Z', now)).toBe(false)
    expect(loginIsBanned(null, now)).toBe(false)
    expect(loginIsBanned('not a date', now)).toBe(false)
  })
  it('finds the suspended logins through the database function, falls back to the auth API, and treats a failed lookup as not suspended', async () => {
    rpc.mockReset(); getUserById.mockReset()
    rpc.mockImplementation(async (_fn: string, args: { p_user_id: string }) => {
      if (args.p_user_id === 'banned') return { data: '2126-11-10T00:00:00Z', error: null }
      if (args.p_user_id === 'fine') return { data: null, error: null }
      if (args.p_user_id === 'no-rpc') return { data: null, error: { message: 'function does not exist' } }
      throw new Error('boom')
    })
    getUserById.mockResolvedValue({ data: { user: { banned_until: '2126-11-10T00:00:00Z' } } })
    const out = await liveBannedUserIds(['banned', 'fine', 'no-rpc', 'broken', 'banned'], now)
    expect(Array.from(out).sort()).toEqual(['banned', 'no-rpc'])
  })
  it('the sender uses both checks, asks for newest phones first with room before the filters, and counts unopened documents in the icon number', () => {
    const src = read('lib/portal-app/send-to-client-phones.ts')
    expect(MAX_FETCH).toBeGreaterThan(MAX_PHONES)
    expect(src).toContain(".order('last_seen_at', { ascending: false })")
    expect(src).toContain('.limit(MAX_FETCH)')
    expect(src).not.toContain('.limit(MAX_PHONES)')
    expect(src).toContain('isCurrentLink(l, nowMs)')
    expect(src).toContain('liveBannedUserIds(picked.map(r => r.user_id))')
    expect(src).toContain('getUnopenedDocsCount(contactId, accounts.map(a => a.id))')
    expect(src).toContain('chat + documents + perCompany')
  })
})
