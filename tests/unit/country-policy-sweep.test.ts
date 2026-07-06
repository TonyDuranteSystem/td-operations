/**
 * Country-policy resolution (S4) — the pure half of the auto-sweep. Fixtures
 * from the dual adversarial review: workspace-over-account precedence, newest
 * workspace answer wins, system batches are NEVER policies (self-reference
 * loop), undone/revoked answers drop out, residence country always excluded,
 * full-year detection is exact (a Feb–Dec answer is a period, not a policy),
 * multi-code (country+EU merge) rows contribute every code.
 */
import { describe, it, expect } from 'vitest'
import {
  isFullYearPolicyRow,
  resolveCountryPolicies,
  LOCATION_ANSWER_SOURCES,
  type WorkspacePolicyRow,
  type AccountPolicyRow,
} from '@/lib/tax/country-policy-sweep'

let seq = 0
const wsAnswer = (over: Partial<WorkspacePolicyRow> = {}): WorkspacePolicyRow => ({
  id: `b${seq++}`,
  loc_codes: ['ES'],
  period_start: '2025-01-01',
  period_end: '2025-12-31',
  choice: 'business',
  actor_role: 'staff',
  created_at: `2026-07-0${(seq % 8) + 1}T00:00:00Z`,
  undone_at: null,
  policy_revoked_at: null,
  ...over,
})
const acctPolicy = (over: Partial<AccountPolicyRow> = {}): AccountPolicyRow => ({
  id: `p${seq++}`,
  loc_code: 'ES',
  choice: 'business',
  active: true,
  ...over,
})

describe('isFullYearPolicyRow', () => {
  it('accepts an exact full-year range', () => {
    expect(isFullYearPolicyRow({ period_start: '2025-01-01', period_end: '2025-12-31' }, 2025)).toBe(true)
  })
  it('rejects a partial-year period (Feb–Dec is a period, not a policy)', () => {
    expect(isFullYearPolicyRow({ period_start: '2025-02-01', period_end: '2025-12-31' }, 2025)).toBe(false)
    expect(isFullYearPolicyRow({ period_start: '2025-01-01', period_end: '2025-11-30' }, 2025)).toBe(false)
  })
  it('accepts a range wider than the year', () => {
    expect(isFullYearPolicyRow({ period_start: '2024-12-01', period_end: '2026-01-15' }, 2025)).toBe(true)
  })
  it('rejects another year entirely', () => {
    expect(isFullYearPolicyRow({ period_start: '2024-01-01', period_end: '2024-12-31' }, 2025)).toBe(false)
  })
})

describe('resolveCountryPolicies', () => {
  it('returns an account policy when the workspace has no answer', () => {
    const out = resolveCountryPolicies({
      workspaceAnswers: [],
      accountPolicies: [acctPolicy({ loc_code: 'PT', choice: 'personal' })],
      taxYear: 2025,
      residenceCountry: 'AE',
    })
    expect(out).toEqual([expect.objectContaining({ loc_code: 'PT', choice: 'personal', source: 'account' })])
  })

  it('workspace answer outranks the account policy for the same country', () => {
    const ws = wsAnswer({ loc_codes: ['ES'], choice: 'personal' })
    const out = resolveCountryPolicies({
      workspaceAnswers: [ws],
      accountPolicies: [acctPolicy({ loc_code: 'ES', choice: 'business' })],
      taxYear: 2025,
      residenceCountry: 'AE',
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ loc_code: 'ES', choice: 'personal', source: 'workspace', source_id: ws.id })
  })

  it('newest workspace answer wins within a country', () => {
    const older = wsAnswer({ choice: 'business', created_at: '2026-07-01T00:00:00Z' })
    const newer = wsAnswer({ choice: 'personal', created_at: '2026-07-05T00:00:00Z' })
    const out = resolveCountryPolicies({
      workspaceAnswers: [older, newer],
      accountPolicies: [],
      taxYear: 2025,
      residenceCountry: null,
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ choice: 'personal', source_id: newer.id })
  })

  it('system batches are never policies (self-reference loop guard)', () => {
    const out = resolveCountryPolicies({
      workspaceAnswers: [wsAnswer({ actor_role: 'system' })],
      accountPolicies: [],
      taxYear: 2025,
      residenceCountry: null,
    })
    expect(out).toEqual([])
  })

  it('undone and revoked answers drop out', () => {
    const out = resolveCountryPolicies({
      workspaceAnswers: [
        wsAnswer({ loc_codes: ['ES'], undone_at: '2026-07-05T00:00:00Z' }),
        wsAnswer({ loc_codes: ['PT'], policy_revoked_at: '2026-07-05T00:00:00Z' }),
      ],
      accountPolicies: [],
      taxYear: 2025,
      residenceCountry: null,
    })
    expect(out).toEqual([])
  })

  it('inactive account policies drop out', () => {
    const out = resolveCountryPolicies({
      workspaceAnswers: [],
      accountPolicies: [acctPolicy({ active: false })],
      taxYear: 2025,
      residenceCountry: null,
    })
    expect(out).toEqual([])
  })

  it('residence country is never a policy, from either source', () => {
    const out = resolveCountryPolicies({
      workspaceAnswers: [wsAnswer({ loc_codes: ['AE'] })],
      accountPolicies: [acctPolicy({ loc_code: 'AE' })],
      taxYear: 2025,
      residenceCountry: 'AE',
    })
    expect(out).toEqual([])
  })

  it('partial-year answers are periods, not policies', () => {
    const out = resolveCountryPolicies({
      workspaceAnswers: [wsAnswer({ period_start: '2025-02-01', period_end: '2025-07-31' })],
      accountPolicies: [],
      taxYear: 2025,
      residenceCountry: null,
    })
    expect(out).toEqual([])
  })

  it('a multi-code full-year answer (country + EU merge) yields a policy per code', () => {
    const out = resolveCountryPolicies({
      workspaceAnswers: [wsAnswer({ loc_codes: ['ES', 'EU'] })],
      accountPolicies: [],
      taxYear: 2025,
      residenceCountry: 'AE',
    })
    expect(out.map(p => p.loc_code).sort()).toEqual(['ES', 'EU'])
  })

  it('merges disjoint countries from both sources, sorted by code', () => {
    const out = resolveCountryPolicies({
      workspaceAnswers: [wsAnswer({ loc_codes: ['ES'] })],
      accountPolicies: [acctPolicy({ loc_code: 'PT' }), acctPolicy({ loc_code: 'GB', choice: 'personal' })],
      taxYear: 2025,
      residenceCountry: 'AE',
    })
    expect(out.map(p => `${p.loc_code}:${p.source}`)).toEqual(['ES:workspace', 'GB:account', 'PT:account'])
  })
})

describe('LOCATION_ANSWER_SOURCES', () => {
  it('period scope stays deterministic-only; country scope includes AI reads (F3)', () => {
    expect(LOCATION_ANSWER_SOURCES.period).toEqual(['text', 'map'])
    expect(LOCATION_ANSWER_SOURCES.country).toEqual(['text', 'map', 'ai'])
  })
})
