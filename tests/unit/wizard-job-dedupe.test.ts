/**
 * Duplicate-submission guard for portal wizard jobs (LT Program incident #2,
 * 2026-07-07: 5 identical tax_form_setup jobs from client submit retries).
 *
 * Locks in:
 *   1. Same submission input → same dedupe key (retries collide).
 *   2. Any changed dimension (data field, wizard type, subject) → new key.
 *   3. findRecentDuplicateJob returns the recent twin when one exists.
 *   4. Lookup errors → null (default to enqueueing, never drop a submission).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Chainable supabase mock: every filter returns the chain, limit() resolves.
let queryResult: { data: unknown[] | null; error: { message: string } | null } = { data: [], error: null }
const filters: Record<string, unknown[]> = {}

function makeChain() {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'gte', 'in', 'order']) {
    chain[m] = vi.fn((...args: unknown[]) => {
      filters[m] = [...(filters[m] || []), args]
      return chain
    })
  }
  chain.limit = vi.fn(async () => queryResult)
  return chain
}

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: vi.fn(() => makeChain()),
  },
}))

import { buildWizardJobDedupeKey, findRecentDuplicateJob } from '@/lib/portal/wizard-job-dedupe'

const BASE = {
  wizardType: 'tax',
  accountId: 'acct-1',
  contactId: 'contact-1',
  leadId: null,
  data: { llc_name: 'Test LLC', total_revenue: '50000' },
}

beforeEach(() => {
  queryResult = { data: [], error: null }
  for (const k of Object.keys(filters)) delete filters[k]
})

describe('buildWizardJobDedupeKey', () => {
  it('is stable for identical input (retry collides)', () => {
    expect(buildWizardJobDedupeKey(BASE)).toBe(buildWizardJobDedupeKey({ ...BASE }))
  })

  it('changes when a data field changes (real resubmission passes)', () => {
    const changed = { ...BASE, data: { ...BASE.data, total_revenue: '60000' } }
    expect(buildWizardJobDedupeKey(changed)).not.toBe(buildWizardJobDedupeKey(BASE))
  })

  it('changes across wizard types and subjects', () => {
    expect(buildWizardJobDedupeKey({ ...BASE, wizardType: 'onboarding' })).not.toBe(buildWizardJobDedupeKey(BASE))
    expect(buildWizardJobDedupeKey({ ...BASE, accountId: 'acct-2' })).not.toBe(buildWizardJobDedupeKey(BASE))
  })

  it('treats undefined and null subject ids the same (payload normalization)', () => {
    const a = buildWizardJobDedupeKey({ ...BASE, leadId: undefined })
    const b = buildWizardJobDedupeKey({ ...BASE, leadId: null })
    expect(a).toBe(b)
  })
})

describe('findRecentDuplicateJob', () => {
  it('returns the recent twin job when one exists', async () => {
    queryResult = { data: [{ id: 'job-1', status: 'completed' }], error: null }
    const dup = await findRecentDuplicateJob('tax_form_setup', 'abc123')
    expect(dup).toEqual({ id: 'job-1', status: 'completed' })
  })

  it('returns null when no twin exists', async () => {
    expect(await findRecentDuplicateJob('tax_form_setup', 'abc123')).toBeNull()
  })

  it('returns null on lookup error — enqueue must proceed', async () => {
    queryResult = { data: null, error: { message: 'boom' } }
    expect(await findRecentDuplicateJob('tax_form_setup', 'abc123')).toBeNull()
  })
})
