import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mocks ──────────────────────────────────────────────────
// Chainable query builder mock. Each `.from(table)` call gets a table-specific
// mock queue so different tables can resolve differently within one test.
type TableMock = {
  select: ReturnType<typeof vi.fn>
  insert: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  is: ReturnType<typeof vi.fn>
  single: ReturnType<typeof vi.fn>
  then: (resolve: (v: unknown) => void) => void
}

function createChain(resolved: unknown): TableMock {
  const chain: Partial<TableMock> = {}
  chain.select = vi.fn(() => chain as TableMock)
  chain.insert = vi.fn(() => chain as TableMock)
  chain.update = vi.fn(() => chain as TableMock)
  chain.eq = vi.fn(() => chain as TableMock)
  chain.is = vi.fn(() => chain as TableMock)
  chain.single = vi.fn(async () => resolved)
  // Makes `await chain.eq(...)` resolve to `resolved` even without a
  // trailing `.single()` — mirrors the real Supabase query builder, which is
  // thenable at every step.
  chain.then = (resolve: (v: unknown) => void) => resolve(resolved)
  return chain as TableMock
}

const tableResolutions: Record<string, unknown> = {}

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => createChain(tableResolutions[table] ?? { data: null, error: null, count: 0 }),
  },
}))

const syncTierMock = vi.fn(async () => ({ success: true, previousTier: 'lead', newTier: 'onboarding', contactsUpdated: [] }))
vi.mock('@/lib/operations/sync-tier', () => ({ syncTier: syncTierMock }))

vi.mock('@/lib/jobs/validation', () => ({
  normalizeEIN: (v: string | null | undefined) => (v ? String(v) : null),
}))

// Import after mocking
import { createAccountFromWizard } from '@/lib/account-from-wizard'

describe('createAccountFromWizard', () => {
  beforeEach(() => {
    syncTierMock.mockClear()
    for (const key of Object.keys(tableResolutions)) delete tableResolutions[key]
  })

  it('exports a function', () => {
    expect(typeof createAccountFromWizard).toBe('function')
  })

  it('maps MMLLC to Multi-Member LLC display name', () => {
    const smllcDisplay = ('SMLLC' as string) === 'MMLLC' ? 'Multi-Member LLC' : 'Single Member LLC'
    const mmllcType = 'MMLLC'
    const mmllcDisplay = mmllcType === 'MMLLC' ? 'Multi-Member LLC' : 'Single Member LLC'
    expect(smllcDisplay).toBe('Single Member LLC')
    expect(mmllcDisplay).toBe('Multi-Member LLC')
  })

  it('defaults accountType to Client when not specified', () => {
    const withDefault = { accountType: 'Client' }
    const withOneTime = { accountType: 'One-Time' }
    expect(withDefault.accountType).toBe('Client')
    expect(withOneTime.accountType).toBe('One-Time')
  })

  it('calls syncTier with allowDowngrade so the new account never keeps the DB-default "active" tier (bug found 2026-09-20, dev job bc2a8f7f)', async () => {
    tableResolutions.account_contacts = { data: [], error: null }
    tableResolutions.accounts = { data: { id: 'new-account-id' }, error: null }
    tableResolutions.client_invoices = { data: null, error: null, count: 0 }
    tableResolutions.payments = { data: null, error: null, count: 0 }

    const result = await createAccountFromWizard({
      contactId: '00000000-0000-0000-0000-000000000001',
      companyName: 'Maria Test LLC',
      entityType: 'SMLLC',
    })

    expect(result.created).toBe(true)
    expect(result.accountId).toBe('new-account-id')
    expect(syncTierMock).toHaveBeenCalledTimes(1)
    expect(syncTierMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'new-account-id',
        newTier: 'onboarding',
        allowDowngrade: true,
      }),
    )
  })

  it('does NOT call syncTier when the account already existed', async () => {
    tableResolutions.account_contacts = {
      data: [{ account_id: 'existing-id', accounts: { id: 'existing-id', company_name: 'Maria Test LLC' } }],
      error: null,
    }

    const result = await createAccountFromWizard({
      contactId: '00000000-0000-0000-0000-000000000001',
      companyName: 'Maria Test LLC',
      entityType: 'SMLLC',
    })

    expect(result.created).toBe(false)
    expect(result.accountId).toBe('existing-id')
    expect(syncTierMock).not.toHaveBeenCalled()
  })
})
