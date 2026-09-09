/**
 * Unit tests for app/(dashboard)/accounts/actions.ts::updateDBADetails.
 *
 * Covers: field whitelisting, sanitization (string trim, numeric coercion),
 * required-field validation (cannot null out dba_name / jurisdiction),
 * optimistic-lock retry path when updated_at doesn't match, and
 * revalidatePath fires on the parent account.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const revalidatePathCalls: string[] = []
const updateCallLog: Array<{ patch: Record<string, unknown>; eqs: Array<{ col: string; val: string }> }> = []

let updateRows: Array<{ id: string; updated_at: string }> | null = [{ id: 'dba-1', updated_at: 'NEW-TS' }]
let updateError: { message: string } | null = null
// The re-check read the retry path now does before writing (second
// bug-hunter pass, dev job e7352aa6) — defaults to matching what every
// existing test already passes as the lock timestamp, so only the tests
// that specifically exercise the new conflict-detection change it.
let dbaCurrentUpdatedAt: string | null = 'OLD-TS'
// Per-call override queue: shift()ed on each update().eq().eq().select()
// resolution, falling back to `updateRows` once exhausted. Lets a test
// distinguish the first (locked) attempt from the retry, which the flat
// `updateRows` variable can't do on its own.
let updateRowsQueue: Array<Array<{ id: string; updated_at: string }>> = []

vi.mock('next/cache', () => ({
  revalidatePath: (path: string) => {
    revalidatePathCalls.push(path)
  },
}))

// supabaseAdmin Proxy mock — covers the typed surfaces (service_deliveries
// for revalidate path, generic untyped surface for dba_details writes).
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'service_deliveries') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { account_id: 'acct-1' } }),
            }),
          }),
        }
      }
      if (table === 'dba_details') {
        return {
          // Serves two different callers: the delivery_id lookup (terminal
          // .single()) and the retry path's re-check read (terminal
          // .maybeSingle(), added in the second bug-hunter pass) — both
          // reach this same shape, differentiated only by which terminal
          // method they call.
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { delivery_id: 'sd-1' } }),
              maybeSingle: () =>
                Promise.resolve({
                  data: dbaCurrentUpdatedAt === null ? null : { updated_at: dbaCurrentUpdatedAt },
                  error: null,
                }),
            }),
          }),
          update: (patch: Record<string, unknown>) => {
            const eqs: Array<{ col: string; val: string }> = []
            // First call returns the optimistic-lock path (.eq -> .eq -> .select)
            // Second call is the retry path, now ALSO .eq -> .eq -> .select
            // (id + updated_at, same as the first attempt) rather than id alone.
            const lockChain = {
              eq: (col: string, val: string) => {
                eqs.push({ col, val })
                return {
                  eq: (col2: string, val2: string) => {
                    eqs.push({ col: col2, val: val2 })
                    return {
                      select: () => {
                        updateCallLog.push({ patch, eqs: [...eqs] })
                        if (updateError) return Promise.resolve({ data: null, error: updateError })
                        const rows = updateRowsQueue.length > 0 ? updateRowsQueue.shift()! : updateRows
                        return Promise.resolve({ data: rows, error: null })
                      },
                    }
                  },
                  select: () => {
                    updateCallLog.push({ patch, eqs: [...eqs] })
                    if (updateError) return Promise.resolve({ data: null, error: updateError })
                    return Promise.resolve({ data: updateRows, error: null })
                  },
                }
              },
            }
            return lockChain
          },
        }
      }
      return {
        insert: () => Promise.resolve({ error: null }),
      }
    },
  },
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'u1', email: 'admin@tonydurante.us' } }, error: null }) },
    from: () => ({ insert: () => Promise.resolve({ error: null }) }),
  }),
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

// Import after mocks register.
import { updateDBADetails } from '@/app/(dashboard)/accounts/actions'

beforeEach(() => {
  revalidatePathCalls.length = 0
  updateCallLog.length = 0
  updateRows = [{ id: 'dba-1', updated_at: 'NEW-TS' }]
  updateError = null
  dbaCurrentUpdatedAt = 'OLD-TS'
  updateRowsQueue = []
})

describe('updateDBADetails', () => {
  it('rejects unknown fields', async () => {
    const result = await updateDBADetails('dba-1', { not_a_field: 'x' } as never, 'OLD-TS')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/no editable fields/i)
  })

  it('rejects nulling out the required dba_name field', async () => {
    const result = await updateDBADetails('dba-1', { dba_name: '' }, 'OLD-TS')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/dba name/i)
  })

  it('rejects nulling out the required jurisdiction field', async () => {
    const result = await updateDBADetails('dba-1', { jurisdiction: '   ' }, 'OLD-TS')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/jurisdiction/i)
  })

  it('coerces filing_fee to a finite number, else null', async () => {
    await updateDBADetails('dba-1', { filing_fee: 12.5 }, 'OLD-TS')
    expect(updateCallLog[0].patch).toMatchObject({ filing_fee: 12.5 })

    updateCallLog.length = 0
    await updateDBADetails('dba-1', { filing_fee: Number.NaN }, 'OLD-TS')
    expect(updateCallLog[0].patch).toMatchObject({ filing_fee: null })
  })

  it('trims string fields and treats empty as null', async () => {
    await updateDBADetails('dba-1', { registration_number: '  ABC-123  ' }, 'OLD-TS')
    expect(updateCallLog[0].patch).toMatchObject({ registration_number: 'ABC-123' })

    updateCallLog.length = 0
    await updateDBADetails('dba-1', { registration_number: '  ' }, 'OLD-TS')
    expect(updateCallLog[0].patch).toMatchObject({ registration_number: null })
  })

  it('uses optimistic lock — matches on id + updated_at', async () => {
    await updateDBADetails('dba-1', { notes: 'updated' }, 'OLD-TS')
    expect(updateCallLog[0].eqs).toEqual([
      { col: 'id', val: 'dba-1' },
      { col: 'updated_at', val: 'OLD-TS' },
    ])
  })

  it('retries locked by id + updated_at (not id alone) when the row genuinely still matches (bug-hunter pass, dev job e7352aa6)', async () => {
    // First attempt "misses" (stale cache read); the re-check confirms the
    // row's real current updated_at still matches what was read; the retry
    // write then succeeds. Queue: call 1 (locked attempt) misses, call 2
    // (retry) matches.
    updateRowsQueue = [[], [{ id: 'dba-1', updated_at: 'NEW-TS' }]]
    dbaCurrentUpdatedAt = 'OLD-TS'
    const result = await updateDBADetails('dba-1', { notes: 'updated' }, 'OLD-TS')
    expect(result.success).toBe(true)
    expect(updateCallLog.length).toBe(2)
    // Both attempts — including the retry — are locked by id + updated_at,
    // never by id alone.
    expect(updateCallLog[0].eqs).toEqual([
      { col: 'id', val: 'dba-1' },
      { col: 'updated_at', val: 'OLD-TS' },
    ])
    expect(updateCallLog[1].eqs).toEqual([
      { col: 'id', val: 'dba-1' },
      { col: 'updated_at', val: 'OLD-TS' },
    ])
  })

  it('refuses instead of silently overwriting when the row genuinely changed (bug-hunter pass, dev job e7352aa6)', async () => {
    updateRows = []
    dbaCurrentUpdatedAt = 'SOMEONE-ELSE-CHANGED-THIS'
    const result = await updateDBADetails('dba-1', { notes: 'updated' }, 'OLD-TS')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/changed since it was loaded/)
    // The whole point: only the first (failed) attempt happens, never an
    // unconditional retry write.
    expect(updateCallLog.length).toBe(1)
  })

  it('refuses when the row no longer exists at all', async () => {
    updateRows = []
    dbaCurrentUpdatedAt = null
    const result = await updateDBADetails('dba-1', { notes: 'updated' }, 'OLD-TS')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/)
  })

  it('refuses when the retry write itself matches zero rows (something else raced the re-check)', async () => {
    updateRows = []
    dbaCurrentUpdatedAt = 'OLD-TS'
    const result = await updateDBADetails('dba-1', { notes: 'updated' }, 'OLD-TS')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/changed since it was loaded/)
  })

  it('revalidates the parent account path on success', async () => {
    const result = await updateDBADetails('dba-1', { notes: 'updated' }, 'OLD-TS')
    expect(result.success).toBe(true)
    expect(revalidatePathCalls).toContain('/accounts/acct-1')
  })

  it('surfaces a database error message', async () => {
    updateError = { message: 'permission denied' }
    const result = await updateDBADetails('dba-1', { notes: 'updated' }, 'OLD-TS')
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/permission denied/)
  })
})
