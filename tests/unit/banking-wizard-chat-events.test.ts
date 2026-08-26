import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Regression guard for dev job fb527ac8: bank application submissions
 * (Payset/Relay) via the portal wizard must produce a marked, What's-New-
 * visible chat note (separate from the existing unmarked client-facing
 * confirmation), and a genuine resubmission must be able to retire the old
 * note so the new one isn't swallowed by emitClientChatEvent's marker dedup.
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

import { emitBankingWizardSubmittedEvent, retireBankingWizardSubmittedNote } from '@/lib/portal/chat-events'

describe('emitBankingWizardSubmittedEvent', () => {
  beforeEach(() => {
    existingRow = null
    inserted = null
  })

  it('emits under the new banking_wizard_submitted kind, scoped to the banking_submissions row', async () => {
    const result = await emitBankingWizardSubmittedEvent({
      banking_submission_id: 'sub-1',
      account_id: 'acct-1',
      contact_id: null,
      provider: 'Payset (EUR)',
    })
    expect(result.emitted).toBe(true)
    expect(inserted).toMatchObject({ account_id: 'acct-1', sender_type: 'system' })
    expect(String(inserted?.message)).toContain('Client submitted a Payset (EUR) banking application')
    expect(String(inserted?.message)).toContain(
      '<!-- chat-event: kind=banking_wizard_submitted src=banking_submissions:sub-1 -->',
    )
  })

  it('uses resubmission wording when is_resubmission is true', async () => {
    await emitBankingWizardSubmittedEvent({
      banking_submission_id: 'sub-1',
      account_id: 'acct-1',
      provider: 'Relay (USD)',
      is_resubmission: true,
    })
    expect(String(inserted?.message)).toContain('Client resubmitted a Relay (USD) banking application')
  })

  it('is skipped (already_emitted) when a note for the same banking_submissions id already exists', async () => {
    existingRow = { id: 'old-note' }
    const result = await emitBankingWizardSubmittedEvent({
      banking_submission_id: 'sub-1',
      account_id: 'acct-1',
      provider: 'Payset (EUR)',
    })
    expect(result.emitted).toBe(false)
    expect(result.reason).toBe('already_emitted')
    expect(inserted).toBeNull()
  })
})

describe('retireBankingWizardSubmittedNote', () => {
  beforeEach(() => {
    updatePayload = null
    updateMarkerFilter = null
    retiredRows = []
    retireError = null
  })

  it('soft-deletes the matching marker row and reports how many were retired', async () => {
    retiredRows = [{ id: 'old-note' }]
    const result = await retireBankingWizardSubmittedNote({ bankingSubmissionId: 'sub-1' })
    expect(result.retired).toBe(1)
    expect(updatePayload).toMatchObject({ deleted_by: '00000000-0000-0000-0000-000000000000' })
    expect(typeof (updatePayload as { deleted_at?: unknown })?.deleted_at).toBe('string')
    expect(updateMarkerFilter).toContain('kind=banking_wizard_submitted src=banking_submissions:sub-1')
  })

  it('returns retired: 0, non-fatal, when nothing matches', async () => {
    retiredRows = []
    const result = await retireBankingWizardSubmittedNote({ bankingSubmissionId: 'sub-missing' })
    expect(result.retired).toBe(0)
  })

  it('returns retired: 0, non-fatal, on a DB error', async () => {
    retireError = { message: 'boom' }
    const result = await retireBankingWizardSubmittedNote({ bankingSubmissionId: 'sub-1' })
    expect(result.retired).toBe(0)
  })
})
