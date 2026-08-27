import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Regression guard for dev job 9b7892d6: a client confirming their P&L and
 * Balance Sheet must produce a marked, What's-New-visible chat note, and a
 * genuine re-attestation (after a correction) must be able to retire the old
 * note so the new one isn't swallowed by emitClientChatEvent's marker dedup.
 * Mirrors tests/unit/banking-wizard-chat-events.test.ts.
 */

let existingRow: { id: string } | null = null
let inserted: Record<string, unknown> | null = null
let updatePayload: Record<string, unknown> | null = null
let updateMarkerFilter: string | null = null
let retiredRows: Array<{ id: string }> = []
let retireError: { message: string } | null = null

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => makeSelectChain(),
      insert: (row: Record<string, unknown>) => {
        inserted = row
        return {
          select: () => ({
            single: async () => ({ data: { id: 'new-msg-id' }, error: null }),
          }),
        }
      },
      update: (payload: Record<string, unknown>) => {
        updatePayload = payload
        return makeUpdateChain()
      },
    }),
  },
}))

function makeSelectChain() {
  const chain = {
    eq: () => chain,
    like: () => chain,
    is: () => chain,
    limit: () => chain,
    maybeSingle: async () => ({ data: existingRow }),
  }
  return chain
}

function makeUpdateChain() {
  const chain = {
    eq: () => chain,
    like: (_col: string, pattern: string) => {
      updateMarkerFilter = pattern
      return chain
    },
    is: () => chain,
    select: async () => ({ data: retireError ? null : retiredRows, error: retireError }),
  }
  return chain
}

import { emitFinancialsAttestedEvent, retireFinancialsAttestedNote } from '@/lib/portal/chat-events'

describe('emitFinancialsAttestedEvent', () => {
  beforeEach(() => {
    existingRow = null
    inserted = null
  })

  it('emits under the financials_attested kind, scoped to the tax_return_submissions row', async () => {
    const result = await emitFinancialsAttestedEvent({
      tax_return_submission_id: 'sub-1',
      account_id: 'acct-1',
      tax_year: 2026,
    })
    expect(result.emitted).toBe(true)
    expect(inserted).toMatchObject({ account_id: 'acct-1', sender_type: 'system' })
    expect(String(inserted?.message)).toContain('Client confirmed the generated P&L and Balance Sheet for 2026')
    expect(String(inserted?.message)).toContain(
      '<!-- chat-event: kind=financials_attested src=tax_return_submissions:sub-1 -->',
    )
  })

  it('uses re-attestation wording when is_reattestation is true', async () => {
    await emitFinancialsAttestedEvent({
      tax_return_submission_id: 'sub-1',
      account_id: 'acct-1',
      tax_year: 2026,
      is_reattestation: true,
    })
    expect(String(inserted?.message)).toContain('Client re-confirmed the generated P&L and Balance Sheet for 2026 after a correction')
  })

  it('is skipped (already_emitted) when a note for the same submission id already exists', async () => {
    existingRow = { id: 'old-note' }
    const result = await emitFinancialsAttestedEvent({
      tax_return_submission_id: 'sub-1',
      account_id: 'acct-1',
      tax_year: 2026,
    })
    expect(result.emitted).toBe(false)
    expect(result.reason).toBe('already_emitted')
    expect(inserted).toBeNull()
  })
})

describe('retireFinancialsAttestedNote', () => {
  beforeEach(() => {
    updatePayload = null
    updateMarkerFilter = null
    retiredRows = []
    retireError = null
  })

  it('soft-deletes the matching marker row and reports how many were retired', async () => {
    retiredRows = [{ id: 'old-note' }]
    const result = await retireFinancialsAttestedNote({ taxReturnSubmissionId: 'sub-1' })
    expect(result.retired).toBe(1)
    expect(updatePayload).toMatchObject({ deleted_by: '00000000-0000-0000-0000-000000000000' })
    expect(typeof (updatePayload as { deleted_at?: unknown })?.deleted_at).toBe('string')
    expect(updateMarkerFilter).toContain('kind=financials_attested src=tax_return_submissions:sub-1')
  })

  it('returns retired: 0, non-fatal, when nothing matches', async () => {
    retiredRows = []
    const result = await retireFinancialsAttestedNote({ taxReturnSubmissionId: 'sub-missing' })
    expect(result.retired).toBe(0)
  })

  it('returns retired: 0, non-fatal, on a DB error', async () => {
    retireError = { message: 'boom' }
    const result = await retireFinancialsAttestedNote({ taxReturnSubmissionId: 'sub-1' })
    expect(result.retired).toBe(0)
  })
})
