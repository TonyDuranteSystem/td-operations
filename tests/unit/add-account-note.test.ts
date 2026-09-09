/**
 * Tests for addAccountNote — mirrors add-contact-note.test.ts. Covers the
 * lock-timestamp fix (locks against this function's own fresh read, not the
 * stale page-load value the caller passed in) and, per the third
 * bug-hunter pass (dev job e7352aa6), the previously-untested path where
 * updateWithLock genuinely refuses and that refusal must propagate as a
 * real failure, not a silent success.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockUpdateWithLock, mockRevalidatePath, mockSingle } = vi.hoisted(() => ({
  mockUpdateWithLock: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockSingle: vi.fn(),
}))

vi.mock('@/lib/server-action', () => ({
  safeAction: vi.fn(async (fn: () => Promise<void>) => {
    try {
      await fn()
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }),
  updateWithLock: (...args: unknown[]) => mockUpdateWithLock(...args),
}))

vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: mockSingle,
        })),
      })),
    })),
  })),
}))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: vi.fn(() => ({})) },
}))

vi.mock('@/lib/operations/service-delivery', () => ({
  createSD: vi.fn(),
}))

vi.mock('@/lib/operations/ein-received', () => ({
  triggerEINReceivedWorkflow: vi.fn(),
}))

vi.mock('@/lib/operations/sync-tier', () => ({
  syncTier: vi.fn(),
  syncContactTiersForAccount: vi.fn(),
}))

import { addAccountNote } from '@/app/(dashboard)/accounts/actions'

const ACCOUNT_ID = 'account-1'

beforeEach(() => {
  vi.clearAllMocks()
  mockUpdateWithLock.mockResolvedValue({ success: true })
})

describe('addAccountNote — locks against the fresh read, not the stale page-load value', () => {
  it('uses the just-read updated_at for the lock, ignoring the caller\'s page-load timestamp', async () => {
    mockSingle.mockResolvedValue({ data: { notes: 'old note', updated_at: '2026-01-01T00:05:00Z' } })
    const result = await addAccountNote(ACCOUNT_ID, 'new note', '2026-01-01T00:00:00Z' /* stale */)
    expect(result.success).toBe(true)
    expect(mockUpdateWithLock).toHaveBeenCalledWith(
      'accounts',
      ACCOUNT_ID,
      expect.objectContaining({ notes: expect.stringContaining('new note') }),
      '2026-01-01T00:05:00Z',
    )
  })

  it('propagates a genuine conflict from updateWithLock as a failure, never as a silent success (third bug-hunter pass, dev job e7352aa6)', async () => {
    mockSingle.mockResolvedValue({ data: { notes: 'existing note', updated_at: 'T1' } })
    mockUpdateWithLock.mockResolvedValue({
      success: false,
      error: 'This record changed since it was loaded — reload and try again.',
    })
    const result = await addAccountNote(ACCOUNT_ID, 'a note', 'T0')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/changed since it was loaded/)
  })

  it('refuses an empty note without reading the account or calling the lock at all', async () => {
    const result = await addAccountNote(ACCOUNT_ID, '   ', 'T0')
    expect(result.success).toBe(false)
    expect(mockSingle).not.toHaveBeenCalled()
    expect(mockUpdateWithLock).not.toHaveBeenCalled()
  })

  it('refuses when the account can\'t be found', async () => {
    mockSingle.mockResolvedValue({ data: null })
    const result = await addAccountNote(ACCOUNT_ID, 'a note', 'T0')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/)
    expect(mockUpdateWithLock).not.toHaveBeenCalled()
  })
})
