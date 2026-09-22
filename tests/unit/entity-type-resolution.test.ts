import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: vi.fn() },
}))

import {
  resolveEntityTypeForFormation,
  normalizeEntityCode,
} from '@/lib/portal/entity-type-from-contract'
import { supabaseAdmin } from '@/lib/supabase-admin'

// ─── Mock state ──────────────────────────────────────────

let leadRows: Array<{ id: string }> = []
let offerRows: Array<{ token: string; lead_id: string | null; contact_id: string | null }> = []
let contractRows: Array<{ offer_token: string; llc_type: string | null; signed_at: string }> = []

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {
    select: vi.fn(() => c),
    eq: vi.fn(() => c),
    in: vi.fn(() => c),
    or: vi.fn(() => c),
    order: vi.fn(() => c),
    then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
      resolve({ data: rows, error: null }),
  }
  return c
}

/** Like chain(), but `.eq('lead_id', X)` actually filters `rows` by that
 * field — needed to prove the resolver's own query construction (strict
 * `.eq` when a lead is pinned vs. a broad `.or`) rather than just the data
 * it's handed, since the plain chain() above returns every row regardless
 * of which filter method was called. */
function offersChain(rows: Array<{ token: string; lead_id: string | null; contact_id: string | null }>) {
  const c: Record<string, unknown> = {
    select: vi.fn(() => c),
    eq: vi.fn((col: string, val: string) => {
      if (col === 'lead_id') {
        return chain(rows.filter(r => r.lead_id === val))
      }
      return chain(rows)
    }),
    or: vi.fn(() => chain(rows)), // the broad, unscoped path — returns everything
    order: vi.fn(() => c),
    then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
      resolve({ data: rows, error: null }),
  }
  return c
}

/** Like chain(), but `.in('offer_token', tokens)` actually filters `rows` —
 * needed so a narrowed offers query (see offersChain above) translates into
 * a correspondingly narrowed contracts lookup in these tests, matching what
 * the real Postgres query does. */
function contractsChain(rows: Array<{ offer_token: string; llc_type: string | null; signed_at: string }>) {
  const c: Record<string, unknown> = {
    select: vi.fn(() => c),
    eq: vi.fn(() => c),
    in: vi.fn((col: string, vals: string[]) => {
      if (col === 'offer_token') {
        return chain(rows.filter(r => vals.includes(r.offer_token)))
      }
      return chain(rows)
    }),
    order: vi.fn(() => c),
    then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
      resolve({ data: rows, error: null }),
  }
  return c
}

beforeEach(() => {
  leadRows = []
  offerRows = []
  contractRows = []
  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    if (table === 'leads') return chain(leadRows)
    if (table === 'offers') return offersChain(offerRows)
    if (table === 'contracts') return contractsChain(contractRows)
    return chain([])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any)
})

// ─── normalizeEntityCode ─────────────────────────────────

describe('normalizeEntityCode', () => {
  it('maps codes and long labels in both directions', () => {
    expect(normalizeEntityCode('SMLLC')).toBe('SMLLC')
    expect(normalizeEntityCode('MMLLC')).toBe('MMLLC')
    expect(normalizeEntityCode('Single Member LLC')).toBe('SMLLC')
    expect(normalizeEntityCode('Multi Member LLC')).toBe('MMLLC')
    expect(normalizeEntityCode('  mmllc ')).toBe('MMLLC')
  })

  it('returns null for empty or unrecognized values', () => {
    expect(normalizeEntityCode(null)).toBeNull()
    expect(normalizeEntityCode('')).toBeNull()
    expect(normalizeEntityCode('Corporation')).toBeNull()
    expect(normalizeEntityCode('LLC')).toBeNull()
  })
})

// ─── resolveEntityTypeForFormation ───────────────────────

describe('resolveEntityTypeForFormation', () => {
  it('admin override wins over everything', async () => {
    contractRows = [{ offer_token: 't1', llc_type: 'MMLLC', signed_at: '2026-05-14' }]
    const r = await resolveEntityTypeForFormation({
      contactId: 'c1',
      adminOverride: 'SMLLC',
      submissionEntityType: 'MMLLC',
    })
    expect(r.source).toBe('admin_override')
    expect(r.wizardCode).toBe('SMLLC')
    expect(r.accountLabel).toBe('Single Member LLC')
  })

  it('ADAM MIHALY CASE: signed contract MMLLC + empty wizard → MMLLC via contract', async () => {
    // Replicates LUMA Beauty Global: wizard never captured entity_type,
    // contract (signed at offer time) says MMLLC. Pre-fix code defaulted SMLLC.
    offerRows = [{ token: 'adam-mihaly-pter-nemeskri-2026', lead_id: 'lead-1', contact_id: null }]
    contractRows = [{ offer_token: 'adam-mihaly-pter-nemeskri-2026', llc_type: 'MMLLC', signed_at: '2026-05-14' }]
    const r = await resolveEntityTypeForFormation({
      contactId: 'c1',
      leadId: 'lead-1',
      submissionEntityType: null,
      wizardEntityType: null,
    })
    expect(r.source).toBe('contract')
    expect(r.wizardCode).toBe('MMLLC')
    expect(r.accountLabel).toBe('Multi Member LLC')
    expect(r.conflictWarning).toBeUndefined()
  })

  it('contract wins over a conflicting form value, with a warning', async () => {
    offerRows = [{ token: 't1', lead_id: 'lead-1', contact_id: null }]
    contractRows = [{ offer_token: 't1', llc_type: 'MMLLC', signed_at: '2026-05-14' }]
    const r = await resolveEntityTypeForFormation({
      contactId: 'c1',
      leadId: 'lead-1',
      submissionEntityType: 'SMLLC',
    })
    expect(r.source).toBe('contract')
    expect(r.wizardCode).toBe('MMLLC')
    expect(r.conflictWarning).toContain('contract wins')
  })

  it('Corporation contract → corporation_manual (no LLC materialization)', async () => {
    offerRows = [{ token: 't1', lead_id: 'lead-1', contact_id: null }]
    contractRows = [{ offer_token: 't1', llc_type: 'Corporation', signed_at: '2026-05-14' }]
    const r = await resolveEntityTypeForFormation({ contactId: 'c1', leadId: 'lead-1' })
    expect(r.source).toBe('corporation_manual')
    expect(r.wizardCode).toBeNull()
  })

  it('falls back to the formation form when no signed contract exists', async () => {
    leadRows = [{ id: 'lead-1' }]
    offerRows = [{ token: 't1', lead_id: 'lead-1', contact_id: null }]
    contractRows = [] // offer never signed
    const r = await resolveEntityTypeForFormation({
      contactId: 'c1',
      submissionEntityType: 'MMLLC',
    })
    expect(r.source).toBe('formation_submission')
    expect(r.wizardCode).toBe('MMLLC')
  })

  it('falls back to wizard data when neither contract nor form value exists', async () => {
    const r = await resolveEntityTypeForFormation({
      contactId: 'c1',
      wizardEntityType: 'Multi Member LLC',
    })
    expect(r.source).toBe('wizard_data')
    expect(r.wizardCode).toBe('MMLLC')
  })

  it('conflicting contracts across a multi-company contact → falls back to form data', async () => {
    // Returning client with two signed contracts of different types and no
    // lead pin: the contract source is ambiguous and must not be guessed.
    leadRows = [{ id: 'lead-1' }, { id: 'lead-2' }]
    offerRows = [
      { token: 't1', lead_id: 'lead-1', contact_id: null },
      { token: 't2', lead_id: 'lead-2', contact_id: null },
    ]
    contractRows = [
      { offer_token: 't1', llc_type: 'SMLLC', signed_at: '2026-01-01' },
      { offer_token: 't2', llc_type: 'MMLLC', signed_at: '2026-05-01' },
    ]
    const r = await resolveEntityTypeForFormation({
      contactId: 'c1',
      submissionEntityType: 'SMLLC',
    })
    expect(r.source).toBe('formation_submission')
    expect(r.wizardCode).toBe('SMLLC')
  })

  // dev job bc2a8f7f (2026-09-20/21, round 4 of the onboarding-workspace QA):
  // found LIVE that a returning client with TWO signed contracts for two
  // DIFFERENT new companies (a normal pattern once onboarding — not just
  // formation — uses this resolver: a client bringing a second, later,
  // separate existing company has an entirely separate signed contract) got
  // the WRONG entity type. Antonio's own rule (2026-06-11): "The CRM must be
  // set according to the contract that the client signed" — this must hold
  // per-lead, not get averaged across a client's unrelated other contracts.
  it('a given leadId is PINNED to its own contract, even when the same contact has another signed contract of a DIFFERENT type', async () => {
    offerRows = [
      { token: 'lead-1-offer', lead_id: 'lead-1', contact_id: 'c1' },
      { token: 'lead-2-offer', lead_id: 'lead-2', contact_id: 'c1' },
    ]
    contractRows = [
      { offer_token: 'lead-1-offer', llc_type: 'SMLLC', signed_at: '2026-09-20' },
      { offer_token: 'lead-2-offer', llc_type: 'MMLLC', signed_at: '2026-09-21' }, // more recent
    ]
    const r = await resolveEntityTypeForFormation({ contactId: 'c1', leadId: 'lead-1' })
    expect(r.source).toBe('contract')
    expect(r.wizardCode).toBe('SMLLC') // lead-1's own contract, not lead-2's newer one
  })

  it('the OTHER lead, same setup, correctly resolves to ITS OWN contract too', async () => {
    offerRows = [
      { token: 'lead-1-offer', lead_id: 'lead-1', contact_id: 'c1' },
      { token: 'lead-2-offer', lead_id: 'lead-2', contact_id: 'c1' },
    ]
    contractRows = [
      { offer_token: 'lead-1-offer', llc_type: 'SMLLC', signed_at: '2026-09-20' },
      { offer_token: 'lead-2-offer', llc_type: 'MMLLC', signed_at: '2026-09-21' },
    ]
    const r = await resolveEntityTypeForFormation({ contactId: 'c1', leadId: 'lead-2' })
    expect(r.source).toBe('contract')
    expect(r.wizardCode).toBe('MMLLC')
  })

  it('UNRESOLVED when nothing is available — never defaults to SMLLC', async () => {
    const r = await resolveEntityTypeForFormation({ contactId: 'c1' })
    expect(r.source).toBe('unresolved')
    expect(r.wizardCode).toBeNull()
    expect(r.accountLabel).toBeNull()
    expect(r.detail).toContain('Pass entity_type explicitly')
  })
})
