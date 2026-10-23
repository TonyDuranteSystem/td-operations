import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))
vi.mock('@/lib/portal/document-alerts', () => ({ resolveDocLocale: vi.fn().mockResolvedValue('it') }))

import { supabaseAdmin } from '@/lib/supabase-admin'
import { getShareContext } from '@/lib/portal/document-share-message'

const FILE = '11111111-2222-4333-8444-555555555555'

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

describe('getShareContext', () => {
  beforeEach(() => vi.clearAllMocks())

  it('a personal document (category 2) is never askable — no chat line may name it', async () => {
    mockDb({ documents: [{ id: 'd', file_name: 'Passport.pdf', category: 2, account_id: 'a1', contact_id: 'c1' }] })
    expect(await getShareContext(FILE)).toEqual({ askable: false, reason: 'personal', fileName: 'Passport.pdf' })
  })

  it('a file with no CRM listing is not askable', async () => {
    mockDb({ documents: [] })
    expect(await getShareContext(FILE)).toMatchObject({ askable: false, reason: 'not_listed' })
  })

  it('a document with neither company nor person has no recipient', async () => {
    mockDb({ documents: [{ id: 'd', file_name: 'x.pdf', category: 1, account_id: null, contact_id: null }] })
    expect(await getShareContext(FILE)).toMatchObject({ askable: false, reason: 'no_recipient' })
  })

  it("the company document's own company is pre-selected; a closed company is flagged so it cannot be picked", async () => {
    mockDb({
      documents: [{ id: 'd', file_name: 'OA.pdf', category: 1, account_id: 'a1', contact_id: 'c1' }],
      account_contacts: [{ account_id: 'a2' }],
      accounts: [{ id: 'a1', company_name: 'Open LLC', status: 'Active' }, { id: 'a2', company_name: 'Old LLC', status: 'Cancelled' }],
      contacts: [{ full_name: 'Ada Rossi' }],
      portal_messages: [{ topic: 'ITIN' }, { topic: 'itin' }, { topic: 'Tax' }],
    })
    const ctx = await getShareContext(FILE)
    if (!ctx.askable) throw new Error('expected askable')
    expect(ctx.locale).toBe('it')
    expect(ctx.defaultTopic).toBe('Documents')
    const byKey = Object.fromEntries(ctx.targets.map((t) => [t.key, t]))
    expect(byKey['company:a1']).toMatchObject({ isDefault: true, closed: false, label: 'Open LLC' })
    expect(byKey['company:a2']).toMatchObject({ isDefault: false, closed: true })
    expect(byKey['person:c1']).toMatchObject({ kind: 'person', isDefault: false, accountId: null })
    expect(byKey['company:a1'].topics).toEqual(['ITIN', 'Tax']) // case-insensitive duplicates dropped
  })

  it('a person-only document defaults to the personal chat', async () => {
    mockDb({
      documents: [{ id: 'd', file_name: 'Letter.pdf', category: 1, account_id: null, contact_id: 'c1' }],
      account_contacts: [],
      contacts: [{ full_name: 'Ada Rossi' }],
    })
    const ctx = await getShareContext(FILE)
    if (!ctx.askable) throw new Error('expected askable')
    expect(ctx.targets).toHaveLength(1)
    expect(ctx.targets[0]).toMatchObject({ kind: 'person', isDefault: true })
  })
})
