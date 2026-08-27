import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Regression guard for dev job fbbf4abe (What's New follow-up, 2026-08-27):
 * a tax client's genuine resubmission (e.g. a correction after review_status
 * was already set) must be able to retire the old "wizard_submitted" note so
 * the next emit isn't swallowed by emitClientChatEvent's marker dedup — same
 * class of bug already fixed for banking via retireBankingWizardSubmittedNote.
 * Verified live: real production submission e6fdfd9b-e0af-4a73-ae62-25c8747e28de
 * was corrected 11 days after its first submission and produced no second note
 * before this fix existed.
 */

let updatePayload: Record<string, unknown> | null = null
let updateMarkerFilter: string | null = null
let retiredRows: Array<{ id: string }> = []
let retireError: { message: string } | null = null

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => ({
      update: (payload: Record<string, unknown>) => {
        updatePayload = payload
        return makeUpdateChain()
      },
    }),
  },
}))

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

import { retireWizardSubmittedNote } from '@/lib/portal/chat-events'

describe('retireWizardSubmittedNote', () => {
  beforeEach(() => {
    updatePayload = null
    updateMarkerFilter = null
    retiredRows = []
    retireError = null
  })

  it('soft-deletes the matching marker row and reports how many were retired', async () => {
    retiredRows = [{ id: 'old-note' }]
    const result = await retireWizardSubmittedNote({ taxReturnSubmissionId: 'sub-1' })
    expect(result.retired).toBe(1)
    expect(updatePayload).toMatchObject({ deleted_by: '00000000-0000-0000-0000-000000000000' })
    expect(typeof (updatePayload as { deleted_at?: unknown })?.deleted_at).toBe('string')
    expect(updateMarkerFilter).toContain('kind=wizard_submitted src=tax_return_submissions:sub-1')
  })

  it('returns retired: 0, non-fatal, when nothing matches', async () => {
    retiredRows = []
    const result = await retireWizardSubmittedNote({ taxReturnSubmissionId: 'sub-missing' })
    expect(result.retired).toBe(0)
  })

  it('returns retired: 0, non-fatal, on a DB error', async () => {
    retireError = { message: 'boom' }
    const result = await retireWizardSubmittedNote({ taxReturnSubmissionId: 'sub-1' })
    expect(result.retired).toBe(0)
  })
})
