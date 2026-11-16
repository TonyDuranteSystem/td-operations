import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))
vi.mock('@/lib/portal/document-alerts', () => ({ resolveDocLocale: vi.fn().mockResolvedValue('it') }))
vi.mock('@/lib/auth-admin-helpers', () => ({ listAllAuthUsers: vi.fn().mockResolvedValue([{ id: 'u1', email: 'ada@example.com' }]) }))

import { supabaseAdmin } from '@/lib/supabase-admin'
import { listAllAuthUsers } from '@/lib/auth-admin-helpers'
import { getContactMessageContext, portalLoginStateOf, loginStateForContact } from '@/lib/portal/contact-message-context'

/** Chainable mock: every builder returns the chain; awaiting it (or maybeSingle) resolves the table's rows. */
function table(rows: unknown[]) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'is', 'not', 'in', 'order', 'limit']) c[m] = vi.fn(() => c)
  c.maybeSingle = vi.fn(() => Promise.resolve({ data: rows[0] ?? null, error: null }))
  c.then = (resolve: (v: { data: unknown[]; error: null }) => unknown) => resolve({ data: rows, error: null })
  return c
}
function mockDb(map: Record<string, unknown[]>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(supabaseAdmin.from).mockImplementation(((t: string) => table(map[t] ?? [])) as any)
}

describe('getContactMessageContext', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns null for a contact that does not exist', async () => {
    mockDb({ contacts: [] })
    expect(await getContactMessageContext('missing')).toBeNull()
  })

  it('offers the personal chat first, then each company — and pre-selects NOTHING', async () => {
    mockDb({
      contacts: [{ id: 'c1', full_name: 'Ada Rossi' }],
      account_contacts: [{ account_id: 'a1' }, { account_id: 'a2' }],
      accounts: [{ id: 'a1', company_name: 'Open LLC', status: 'Active' }, { id: 'a2', company_name: 'Other LLC', status: 'Suspended' }],
      portal_messages: [{ topic: 'ITIN' }, { topic: 'itin' }, { topic: 'Tax' }],
    })
    const ctx = await getContactMessageContext('c1')
    if (!ctx || !ctx.askable) throw new Error('expected an askable context')
    expect(ctx.recipientName).toBe('Ada Rossi')
    expect(ctx.locale).toBe('it')
    expect(ctx.defaultTopic).toBe('') // General
    expect(ctx.targets.map((t) => t.key)).toEqual(['person:c1', 'company:a1', 'company:a2'])
    expect(ctx.targets.every((t) => !t.isDefault)).toBe(true) // the 2026-08-07 leak rule: never default-select a chat
    expect(ctx.targets[1].topics).toEqual(['ITIN', 'Tax']) // case-insensitive duplicates dropped
  })

  it('flags a closed company so it cannot be picked', async () => {
    mockDb({
      contacts: [{ id: 'c1', full_name: 'Ada Rossi' }],
      account_contacts: [{ account_id: 'a1' }, { account_id: 'a2' }],
      accounts: [{ id: 'a1', company_name: 'Open LLC', status: 'Active' }, { id: 'a2', company_name: 'Old LLC', status: 'Cancelled' }],
    })
    const ctx = await getContactMessageContext('c1')
    if (!ctx || !ctx.askable) throw new Error('expected an askable context')
    const byKey = Object.fromEntries(ctx.targets.map((t) => [t.key, t]))
    expect(byKey['company:a1'].closed).toBe(false)
    expect(byKey['company:a2'].closed).toBe(true)
    expect(byKey['person:c1'].closed).toBe(false)
  })

  it('a person with no company still has their personal chat', async () => {
    mockDb({ contacts: [{ id: 'c1', full_name: 'Ada Rossi' }], account_contacts: [] })
    const ctx = await getContactMessageContext('c1')
    if (!ctx || !ctx.askable) throw new Error('expected an askable context')
    expect(ctx.targets).toHaveLength(1)
    expect(ctx.targets[0]).toMatchObject({ kind: 'person', isDefault: false, accountId: null })
  })

  it('the same company linked twice is offered once', async () => {
    mockDb({
      contacts: [{ id: 'c1', full_name: 'Ada Rossi' }],
      account_contacts: [{ account_id: 'a1' }, { account_id: 'a1' }],
      accounts: [{ id: 'a1', company_name: 'Open LLC', status: 'Active' }],
    })
    const ctx = await getContactMessageContext('c1')
    if (!ctx || !ctx.askable) throw new Error('expected an askable context')
    expect(ctx.targets.filter((t) => t.kind === 'company')).toHaveLength(1)
  })
})

describe('the "cannot read it yet" notice is worked out by the server when the pop-up opens', () => {
  beforeEach(() => vi.clearAllMocks())
  const ctxFor = async () => {
    mockDb({ contacts: [{ id: 'c1', full_name: 'Ada Rossi', email: 'ada@example.com' }], account_contacts: [] })
    const ctx = await getContactMessageContext('c1')
    if (!ctx || !ctx.askable) throw new Error('expected an askable context')
    return ctx
  }

  it('no notice when the person has a working login', async () => {
    vi.mocked(listAllAuthUsers).mockResolvedValue([{ id: 'u1', email: 'ada@example.com' }] as never)
    expect((await ctxFor()).notice).toBeUndefined()
  })

  it('says so when the person has no login', async () => {
    vi.mocked(listAllAuthUsers).mockResolvedValue([])
    expect((await ctxFor()).notice).toMatch(/Ada Rossi has no portal login yet/)
  })

  it('says so when the login is suspended', async () => {
    vi.mocked(listAllAuthUsers).mockResolvedValue([{ id: 'u1', email: 'ada@example.com', banned_until: '2999-01-01T00:00:00Z' }] as never)
    expect((await ctxFor()).notice).toMatch(/suspended/)
  })

  it('a person with no email and no login tied to them has no login, so the notice says so', async () => {
    vi.mocked(listAllAuthUsers).mockResolvedValue([{ id: 'u1', email: 'someone@else.com' }] as never)
    mockDb({ contacts: [{ id: 'c1', full_name: 'Ada Rossi', email: null }], account_contacts: [] })
    const ctx = await getContactMessageContext('c1')
    if (!ctx || !ctx.askable) throw new Error('expected an askable context')
    expect(ctx.notice).toMatch(/no portal login yet/)
  })

  it('a login tied to the person by contact id counts even under a DIFFERENT email (no false warning)', async () => {
    vi.mocked(listAllAuthUsers).mockResolvedValue([{ id: 'u9', email: 'ada.private@gmail.com', app_metadata: { contact_id: 'c1' } }] as never)
    expect((await ctxFor()).notice).toBeUndefined()
  })

  it('if the login lookup fails, say nothing rather than a false "no login"', async () => {
    vi.mocked(listAllAuthUsers).mockRejectedValue(new Error('auth down'))
    expect((await ctxFor()).notice).toBeUndefined()
  })
})

describe('portalLoginStateOf', () => {
  const now = new Date('2026-11-15T12:00:00Z')
  it('no auth user → no login', () => expect(portalLoginStateOf(null, now)).toEqual({ exists: false, suspended: false }))
  it('auth user with no ban → working login', () => expect(portalLoginStateOf({ banned_until: null }, now)).toEqual({ exists: true, suspended: false }))
  it('a ban in the future → suspended', () => expect(portalLoginStateOf({ banned_until: '2026-12-01T00:00:00Z' }, now)).toEqual({ exists: true, suspended: true }))
  it('a ban already over → working login', () => expect(portalLoginStateOf({ banned_until: '2026-01-01T00:00:00Z' }, now)).toEqual({ exists: true, suspended: false }))
})

describe('loginStateForContact', () => {
  const now = new Date('2026-11-15T12:00:00Z')
  const ada = { id: 'c1', email: 'ada@example.com' }
  it('no matching login → none', () => expect(loginStateForContact(ada, [{ email: 'x@y.com' }], now)).toEqual({ exists: false, suspended: false }))
  it('a working login by email → fine', () => expect(loginStateForContact(ada, [{ email: 'ADA@example.com' }], now)).toEqual({ exists: true, suspended: false }))
  it('a working login by contact id → fine', () => expect(loginStateForContact(ada, [{ email: 'z@z.com', app_metadata: { contact_id: 'c1' } }], now)).toEqual({ exists: true, suspended: false }))
  it('only suspended logins → suspended', () => expect(loginStateForContact(ada, [{ email: 'ada@example.com', banned_until: '2026-12-01T00:00:00Z' }], now)).toEqual({ exists: true, suspended: true }))
  it('one suspended and one working login → fine', () => expect(loginStateForContact(ada, [{ email: 'ada@example.com', banned_until: '2026-12-01T00:00:00Z' }, { email: 'o@o.com', app_metadata: { contact_id: 'c1' } }], now)).toEqual({ exists: true, suspended: false }))
  it('a marketing login never counts', () => expect(loginStateForContact(ada, [{ email: 'ada@example.com', app_metadata: { role: 'marketing' } }], now)).toEqual({ exists: false, suspended: false }))
})

