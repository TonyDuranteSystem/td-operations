/**
 * onboarding_setup job — saveCheckedFilingId (job 64d2be64). The State Filing ID staff checked (or the client typed, when nothing was
 * checked) reaches the company: it FILLS an empty Filing ID, leaves an equal one alone, and never overwrites a different one — the job's
 * step says so instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let currentFilingId: string | null = null
let companyExists = true
let selectError: { message: string } | null = null
let updateError: { message: string } | null = null
// the rows the guarded update reports as written; empty = someone filled the Filing ID between the read and the write
let writtenRows: Array<{ id: string }> = [{ id: 'acct-1' }]
const updates: Array<Record<string, unknown>> = []

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: selectError || !companyExists ? null : { filing_id: currentFilingId }, error: selectError }) }) }),
      update: (patch: Record<string, unknown>) => {
        updates.push(patch)
        return { eq: () => ({ or: () => ({ select: async () => ({ data: updateError ? null : writtenRows, error: updateError }) }) }) }
      },
    }),
  },
}))
// the handler module imports a lot of the app; only the helper under test is used here
vi.mock('@/lib/operations/service-delivery', () => ({ createSD: vi.fn() }))
vi.mock('@/lib/operations/suite', () => ({ companyCmraAddressLine: vi.fn() }))

import { saveCheckedFilingId } from '@/lib/jobs/handlers/onboarding-setup'
import type { JobResult } from '@/lib/jobs/queue'

const NOW = '2026-11-04T12:00:00.000Z'
let result: JobResult

beforeEach(() => {
  currentFilingId = null
  companyExists = true
  selectError = null
  updateError = null
  writtenRows = [{ id: 'acct-1' }]
  updates.length = 0
  result = { steps: [] }
})

describe('saveCheckedFilingId', () => {
  it('fills an empty Filing ID and records the step', async () => {
    await saveCheckedFilingId('acct-1', '2026-002103965', result, NOW)
    expect(updates).toEqual([{ filing_id: '2026-002103965', updated_at: NOW }])
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]).toMatchObject({ name: 'filing_id', status: 'ok' })
  })

  it('treats a blank value as empty', async () => {
    currentFilingId = '   '
    await saveCheckedFilingId('acct-1', '3190157', result, NOW)
    expect(updates).toHaveLength(1)
  })

  it('leaves an equal Filing ID alone, even when it is written differently, without noise', async () => {
    currentFilingId = '2026 - 002103965'
    await saveCheckedFilingId('acct-1', '2026-002103965', result, NOW)
    expect(updates).toHaveLength(0)
    expect(result.steps).toHaveLength(0)
  })

  it('never overwrites a DIFFERENT Filing ID — the step says what was kept and what was not saved', async () => {
    currentFilingId = '3190157'
    await saveCheckedFilingId('acct-1', '3190158', result, NOW)
    expect(updates).toHaveLength(0)
    expect(result.steps[0]).toMatchObject({ name: 'filing_id', status: 'skipped' })
    expect(result.steps[0].detail).toMatch(/3190157/)
    expect(result.steps[0].detail).toMatch(/3190158/)
  })

  it('a failed read or write becomes an error step and never throws', async () => {
    selectError = { message: 'read failed' }
    await saveCheckedFilingId('acct-1', '3190157', result, NOW)
    expect(result.steps[0]).toMatchObject({ name: 'filing_id', status: 'error', detail: 'read failed' })

    selectError = null
    updateError = { message: 'write failed' }
    result = { steps: [] }
    await saveCheckedFilingId('acct-1', '3190157', result, NOW)
    expect(result.steps[0]).toMatchObject({ status: 'error', detail: 'write failed' })
  })

  it('a company that does not exist is an error step, never a quiet "saved"', async () => {
    companyExists = false
    await saveCheckedFilingId('acct-missing', '3190157', result, NOW)
    expect(updates).toHaveLength(0)
    expect(result.steps[0]).toMatchObject({ name: 'filing_id', status: 'error' })
    expect(result.steps[0].detail).toMatch(/not found/)
  })

  it('a Filing ID filled by someone else between the read and the write is not overwritten, and the step says so', async () => {
    writtenRows = []
    await saveCheckedFilingId('acct-1', '3190157', result, NOW)
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]).toMatchObject({ name: 'filing_id', status: 'skipped' })
    expect(result.steps[0].detail).toMatch(/filled by someone else/)
  })
})
