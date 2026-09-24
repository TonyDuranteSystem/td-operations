import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Company Closure form submission → staff What's New note (Antonio,
 * 2026-09-24 — DoctorGut / Patrick Covelli). Before this, a closure
 * submission produced only an email + task. A genuine resubmission must be
 * able to retire the old note so the fresh one isn't swallowed by
 * emitClientChatEvent's marker dedup.
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

import { emitClosureWizardSubmittedEvent, retireClosureWizardSubmittedNote } from '@/lib/portal/chat-events'

describe('emitClosureWizardSubmittedEvent', () => {
  beforeEach(() => {
    existingRow = null
    inserted = null
  })

  it('emits a closure_wizard_submitted note scoped to the closure_submissions row, naming the company being closed', async () => {
    const result = await emitClosureWizardSubmittedEvent({
      closure_submission_id: 'cs-1',
      contact_id: 'contact-1',
      account_id: null,
      llc_name: 'Doctor Veg LLC',
      llc_state: 'Delaware',
    })
    expect(result.emitted).toBe(true)
    expect(inserted).toMatchObject({ contact_id: 'contact-1', account_id: null, sender_type: 'system' })
    expect(String(inserted?.message)).toContain('Client submitted the Company Closure form for Doctor Veg LLC (Delaware)')
    expect(String(inserted?.message)).toContain(
      '<!-- chat-event: kind=closure_wizard_submitted src=closure_submissions:cs-1 -->',
    )
  })

  it('omits the company when unknown, and uses resubmission wording when asked', async () => {
    await emitClosureWizardSubmittedEvent({
      closure_submission_id: 'cs-1',
      contact_id: 'contact-1',
      is_resubmission: true,
    })
    expect(String(inserted?.message)).toContain('Client resubmitted the Company Closure form.')
  })

  it('is skipped (already_emitted) on a retry of the same submission', async () => {
    existingRow = { id: 'old-note' }
    const result = await emitClosureWizardSubmittedEvent({ closure_submission_id: 'cs-1', contact_id: 'contact-1' })
    expect(result.emitted).toBe(false)
    expect(result.reason).toBe('already_emitted')
    expect(inserted).toBeNull()
  })

  it('has no recipient → missing_recipient, nothing inserted', async () => {
    const result = await emitClosureWizardSubmittedEvent({ closure_submission_id: 'cs-1' })
    expect(result).toMatchObject({ emitted: false, reason: 'missing_recipient' })
    expect(inserted).toBeNull()
  })
})

describe('retireClosureWizardSubmittedNote', () => {
  beforeEach(() => {
    updatePayload = null
    updateMarkerFilter = null
    retiredRows = []
    retireError = null
  })

  it('soft-deletes the matching marker row', async () => {
    retiredRows = [{ id: 'old-note' }]
    const result = await retireClosureWizardSubmittedNote({ closureSubmissionId: 'cs-1' })
    expect(result.retired).toBe(1)
    expect(typeof (updatePayload as { deleted_at?: unknown })?.deleted_at).toBe('string')
    expect(updateMarkerFilter).toContain('kind=closure_wizard_submitted src=closure_submissions:cs-1')
  })

  it('returns retired: 0, non-fatal, on a DB error', async () => {
    retireError = { message: 'boom' }
    const result = await retireClosureWizardSubmittedNote({ closureSubmissionId: 'cs-1' })
    expect(result.retired).toBe(0)
  })
})
