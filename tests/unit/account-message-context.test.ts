import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))
vi.mock('@/lib/portal/document-alerts', () => ({ resolveDocLocale: vi.fn().mockResolvedValue('en') }))
vi.mock('@/lib/auth-admin-helpers', () => ({ findAuthUserByEmail: vi.fn(), listAllAuthUsers: vi.fn() }))
vi.mock('@/lib/portal/admin-send-scope', () => ({ accountAudience: vi.fn(), resolveAdminReplyContact: vi.fn() }))

import { supabaseAdmin } from '@/lib/supabase-admin'
import { listAllAuthUsers } from '@/lib/auth-admin-helpers'
import { accountAudience, resolveAdminReplyContact } from '@/lib/portal/admin-send-scope'
import { getAccountMessageContext } from '@/lib/portal/account-message-context'
import { contactsWithWorkingLogin } from '@/lib/portal/contact-message-context'

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
const OPEN = [{ id: 'a1', company_name: 'Open LLC', status: 'Active' }]
const LINKED = {
  accounts: OPEN,
  account_contacts: [{ contact_id: 'c1' }, { contact_id: 'c2' }],
  contacts: [{ id: 'c1', email: 'ada@example.com', full_name: 'Ada Rossi' }, { id: 'c2', email: 'bob@example.com', full_name: 'Bob Verdi' }],
}

async function ctxFor(accountId = 'a1') {
  const ctx = await getAccountMessageContext(accountId)
  if (!ctx || !ctx.askable) throw new Error('expected an askable context')
  return ctx
}

describe('getAccountMessageContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listAllAuthUsers).mockResolvedValue([{ id: 'u1', email: 'ada@example.com' }] as never)
    vi.mocked(accountAudience).mockResolvedValue({ contactCount: 2, chatTeammateCount: 0 })
    vi.mocked(resolveAdminReplyContact).mockResolvedValue('c1')
  })

  it('returns null for a company that does not exist', async () => {
    mockDb({ accounts: [] })
    expect(await getAccountMessageContext('missing')).toBeNull()
  })

  it("offers the company's own chat as the ONLY choice and pre-selects it (the row is the choice)", async () => {
    mockDb(LINKED)
    const ctx = await ctxFor()
    expect(ctx.recipientName).toBe('Open LLC')
    expect(ctx.defaultTopic).toBe('') // General
    expect(ctx.targets).toHaveLength(1)
    expect(ctx.targets[0]).toMatchObject({ key: 'company:a1', kind: 'company', accountId: 'a1', closed: false, isDefault: true })
  })

  it('says who the portal alert goes to — the same person the real send picks', async () => {
    mockDb(LINKED)
    const ctx = await ctxFor()
    expect(resolveAdminReplyContact).toHaveBeenCalledWith('a1', null)
    expect(ctx.info).toMatch(/one person only: Ada Rossi/)
  })

  it('no warning when a linked person has a working login', async () => {
    mockDb(LINKED)
    expect((await ctxFor()).notice).toBeUndefined()
  })

  it('warns when people are linked but nobody has a login and there is no chat teammate', async () => {
    mockDb(LINKED)
    vi.mocked(listAllAuthUsers).mockResolvedValue([])
    expect((await ctxFor()).notice).toMatch(/Nobody at Open LLC has a working portal login/)
  })

  it('a suspended login does not count as someone who can read', async () => {
    mockDb(LINKED)
    vi.mocked(listAllAuthUsers).mockResolvedValue([{ id: 'u1', email: 'ada@example.com', banned_until: '2999-01-01T00:00:00Z' }] as never)
    expect((await ctxFor()).notice).toMatch(/Nobody at Open LLC/)
  })

  it('an active chat teammate means somebody can read it, even with no linked login', async () => {
    mockDb(LINKED)
    vi.mocked(listAllAuthUsers).mockResolvedValue([])
    vi.mocked(accountAudience).mockResolvedValue({ contactCount: 2, chatTeammateCount: 1 })
    expect((await ctxFor()).notice).toBeUndefined()
  })

  it('warns differently when nobody is linked, and gives no alert line', async () => {
    mockDb({ accounts: OPEN, account_contacts: [], contacts: [] })
    vi.mocked(accountAudience).mockResolvedValue({ contactCount: 0, chatTeammateCount: 0 })
    vi.mocked(resolveAdminReplyContact).mockResolvedValue(null)
    const ctx = await ctxFor()
    expect(ctx.notice).toMatch(/Nobody is linked to Open LLC yet/)
    expect(ctx.info).toBeUndefined()
  })

  it('a failed login lookup says nothing rather than a false warning', async () => {
    mockDb(LINKED)
    vi.mocked(listAllAuthUsers).mockRejectedValue(new Error('auth down'))
    expect((await ctxFor()).notice).toBeUndefined()
  })

  it('a failed alert lookup drops only the grey line', async () => {
    mockDb(LINKED)
    vi.mocked(resolveAdminReplyContact).mockRejectedValue(new Error('db down'))
    const ctx = await ctxFor()
    expect(ctx.info).toBeUndefined()
    expect(ctx.targets).toHaveLength(1)
  })

  it('a closed company still returns its chat, flagged closed, so the pop-up cannot send to it', async () => {
    mockDb({ ...LINKED, accounts: [{ id: 'a1', company_name: 'Old LLC', status: 'Cancelled' }] })
    const ctx = await ctxFor()
    expect(ctx.targets[0].closed).toBe(true)
  })
})

describe('contactsWithWorkingLogin — a login is tied to a person by contact id OR email', () => {
  const now = new Date('2026-11-15T12:00:00Z')
  const ada = { id: 'c1', email: 'ada@example.com' }
  const bob = { id: 'c2', email: 'bob@example.com' }
  it('matches by email, case-insensitively', () => {
    expect(contactsWithWorkingLogin([ada], [{ email: 'ADA@Example.com ' }], now)).toBe(1)
  })
  it('matches by contact id even when the login uses a DIFFERENT email (no false "no login")', () => {
    expect(contactsWithWorkingLogin([ada], [{ email: 'ada.private@gmail.com', app_metadata: { contact_id: 'c1' } }], now)).toBe(1)
  })
  it('counts people, not logins', () => {
    expect(contactsWithWorkingLogin([ada], [{ email: 'ada@example.com' }, { email: 'x@y.com', app_metadata: { contact_id: 'c1' } }], now)).toBe(1)
    expect(contactsWithWorkingLogin([ada, bob], [{ email: 'ada@example.com' }, { email: 'bob@example.com' }], now)).toBe(2)
  })
  it('a suspended login does not count; one whose ban is over does', () => {
    expect(contactsWithWorkingLogin([ada], [{ email: 'ada@example.com', banned_until: '2026-12-01T00:00:00Z' }], now)).toBe(0)
    expect(contactsWithWorkingLogin([ada], [{ email: 'ada@example.com', banned_until: '2026-01-01T00:00:00Z' }], now)).toBe(1)
  })
  it('a marketing-workspace login does not count', () => {
    expect(contactsWithWorkingLogin([ada], [{ email: 'ada@example.com', app_metadata: { role: 'marketing' } }], now)).toBe(0)
  })
  it('no logins, or a contact with no email and no id match, means none', () => {
    expect(contactsWithWorkingLogin([ada], [], now)).toBe(0)
    expect(contactsWithWorkingLogin([{ id: 'c9', email: null }], [{ email: 'ada@example.com' }], now)).toBe(0)
  })
})

