import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))
vi.mock('@/lib/portal/document-alerts', () => ({ resolveDocLocale: vi.fn().mockResolvedValue('it') }))

import { supabaseAdmin } from '@/lib/supabase-admin'
import { getContactMessageContext } from '@/lib/portal/contact-message-context'

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
