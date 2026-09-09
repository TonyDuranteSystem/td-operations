/**
 * Tests for changeAccountStatus — specifically the lock-timestamp behavior,
 * corrected in the third bug-hunter pass (dev job e7352aa6) after being
 * caught mid-fix in the same round. Unlike addAccountNote/addContactNote
 * (a pure, commutative append — safe to lock against a fresh read),
 * changeAccountStatus carries real cascades (cancelling deliveries, voiding
 * payments, revoking portal access) tied to a DECISION staff made while
 * looking at a specific old status on their screen. If the account's real
 * status moved since the page loaded, that decision may already be wrong —
 * so this one must stay locked against the page-load updatedAt and refuse
 * on a genuine mismatch, not silently proceed against whatever the status
 * happens to be by the time the write runs.
 *
 * Scoped to the lock behavior only (options: {}, no cascades selected) —
 * the lock check returns before any cascade logic runs, so this doesn't
 * need to mock the cascade internals to prove the fix.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockUpdateWithLock, mockSingle } = vi.hoisted(() => ({
  mockUpdateWithLock: vi.fn(),
  mockSingle: vi.fn(),
}))

vi.mock('@/lib/server-action', () => ({
  safeAction: vi.fn(async (fn: () => Promise<void>) => {
    try {
      await fn()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }),
  updateWithLock: (...args: unknown[]) => mockUpdateWithLock(...args),
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({ insert: () => Promise.resolve({ error: null }) })),
    auth: { getUser: () => Promise.resolve({ data: { user: { email: 'admin@tonydurante.us' } } }) },
  })),
}))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({
          single: mockSingle,
        }),
      }),
    })),
  },
}))

vi.mock('@/lib/operations/service-delivery', () => ({ createSD: vi.fn() }))
vi.mock('@/lib/operations/ein-received', () => ({ triggerEINReceivedWorkflow: vi.fn() }))
vi.mock('@/lib/operations/sync-tier', () => ({ syncTier: vi.fn(), syncContactTiersForAccount: vi.fn() }))

import { changeAccountStatus } from '@/app/(dashboard)/accounts/actions'

const ACCOUNT_ID = 'account-1'

beforeEach(() => {
  vi.clearAllMocks()
  mockUpdateWithLock.mockResolvedValue({ success: true })
})

describe('changeAccountStatus — locks against the page-load value, not a fresh read (third bug-hunter pass, dev job e7352aa6)', () => {
  it('passes the caller\'s original updatedAt to the lock, not this function\'s own fresh read', async () => {
    mockSingle.mockResolvedValue({
      data: { id: ACCOUNT_ID, company_name: 'Acme LLC', state_of_formation: 'WY', status: 'Active', notes: null, updated_at: 'FRESH-TS' },
    })
    const pageLoadTimestamp = 'STALE-PAGE-LOAD-TS'
    await changeAccountStatus(ACCOUNT_ID, 'Closed', {}, '', pageLoadTimestamp)
    expect(mockUpdateWithLock).toHaveBeenCalledWith(
      'accounts',
      ACCOUNT_ID,
      expect.objectContaining({ status: 'Closed' }),
      pageLoadTimestamp,
    )
  })

  it('refuses instead of applying a status change decided against a status that has since moved on', async () => {
    mockSingle.mockResolvedValue({
      data: { id: ACCOUNT_ID, company_name: 'Acme LLC', state_of_formation: 'WY', status: 'Suspended' /* moved on from what staff saw */, notes: null, updated_at: 'T1' },
    })
    mockUpdateWithLock.mockResolvedValue({
      success: false,
      error: 'This record changed since it was loaded — reload and try again.',
    })
    const result = await changeAccountStatus(ACCOUNT_ID, 'Closed', { cancelDeliveries: true }, '', 'T0-stale')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/changed since it was loaded/)
    // The lock check returns before any cascade runs — the function never
    // even reaches the cascade-application code on this path.
  })
})
