/**
 * confirmPortalWizardOnboarding — the State Filing ID staff checked reaches the setup job (job 64d2be64). The number goes into the job
 * payload as `confirmed_filing_id` (null = "no Filing ID on the document"); with NOTHING checked (a stale review tab, another caller) the key is
 * still sent, as null, so the job saves nothing — an unchecked number is never saved. The setup job is what saves it on the company.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const submissionRow = {
  id: 'sub-1', token: 'tok-1', source: 'portal_wizard', status: 'completed', state: 'FL', entity_type: 'SMLLC',
  account_id: null, contact_id: 'contact-1', lead_id: null, reviewed_at: null, reviewed_by: null,
  submitted_data: { company_name: 'Maria Test LLC', state_of_formation: 'Florida', filing_id: '9999999' }, upload_paths: [],
}

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table !== 'onboarding_submissions') throw new Error(`Unexpected table in test: ${table}`)
      const chain: Record<string, unknown> = {}
      chain.select = vi.fn(() => chain)
      chain.eq = vi.fn(() => chain)
      chain.is = vi.fn(() => chain)
      chain.maybeSingle = vi.fn(async () => ({ data: submissionRow, error: null }))
      chain.update = vi.fn(() => ({ eq: () => ({ is: () => ({ select: () => Promise.resolve({ data: [{ id: 'sub-1' }], error: null }) }) }) }))
      return chain
    },
  },
}))
const enqueueJobMock = vi.fn(async (_args: { payload: Record<string, unknown> }) => ({ id: 'job-1' }))
vi.mock('@/lib/jobs/queue', () => ({ enqueueJob: (a: { payload: Record<string, unknown> }) => enqueueJobMock(a) }))

import { confirmPortalWizardOnboarding } from '@/lib/operations/onboarding-review'

beforeEach(() => enqueueJobMock.mockClear())

function payloadOfLastJob() {
  return enqueueJobMock.mock.calls[0][0].payload
}

describe('confirmPortalWizardOnboarding — the checked State Filing ID', () => {
  it('puts the number staff checked into the setup job', async () => {
    const result = await confirmPortalWizardOnboarding('sub-1', 'luca@tonydurante.us', { choice: 'issue' }, { value: '3190157' })
    expect(result.ok).toBe(true)
    expect(payloadOfLastJob().confirmed_filing_id).toBe('3190157')
    expect(result.lines.join('\n')).toMatch(/Filing ID checked on the Articles by luca@tonydurante.us: 3190157/)
  })

  it('"no Filing ID on the document" is carried as null — the key is present so the client\'s own number is not used', async () => {
    const result = await confirmPortalWizardOnboarding('sub-1', 'luca@tonydurante.us', { choice: 'issue' }, { value: null })
    const payload = payloadOfLastJob()
    expect('confirmed_filing_id' in payload).toBe(true)
    expect(payload.confirmed_filing_id).toBeNull()
    expect(result.lines.join('\n')).toMatch(/No Filing ID will be saved from this Confirm/)
  })

  it('with nothing checked the key is still sent, as null — the job never falls back to the number the client typed', async () => {
    const result = await confirmPortalWizardOnboarding('sub-1', 'luca@tonydurante.us', { choice: 'issue' })
    expect('confirmed_filing_id' in payloadOfLastJob()).toBe(true)
    expect(payloadOfLastJob().confirmed_filing_id).toBeNull()
    // and the record says nobody checked, and what the client typed, so staff can add it on the company page
    expect(result.lines.join('\n')).toMatch(/No State Filing ID was checked on this Confirm, so none is saved/)
    expect(result.lines.join('\n')).toMatch(/the client typed "9999999"/)
  })

  it('a number confirmed with no uploaded Articles to open is not described as checked on the Articles', async () => {
    const result = await confirmPortalWizardOnboarding('sub-1', 'luca@tonydurante.us', { choice: 'issue' }, { value: '2026-002103965', documentChecked: false })
    const text = result.lines.join('\n')
    expect(text).toMatch(/confirmed by luca@tonydurante.us — no uploaded Articles could be opened/)
    expect(text).not.toMatch(/checked on the Articles/)
  })
})
