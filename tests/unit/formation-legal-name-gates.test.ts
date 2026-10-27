/**
 * Job 80cce1cb — the pre-check (preflight) and the company creation (materializer) decide the company's name with the SAME rule, and a
 * retry can never create a second company. Real incident: Tanto per was created as "Tanto per" (no LLC) and fixed by hand; 4 of 19 real
 * formations were created without the ending.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Rows = {
  sub?: unknown
  wp?: unknown
  links?: Array<{ account_id: string; accounts: { id: string; company_name: string; status: string } }>
}
const state = vi.hoisted(() => ({ rows: {} as Rows, calls: [] as string[] }))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      state.calls.push(table)
      const result =
        table === 'formation_submissions' ? { data: state.rows.sub ?? null, error: null }
        : table === 'wizard_progress' ? { data: state.rows.wp ?? null, error: null }
        : table === 'account_contacts' ? { data: state.rows.links ?? [], error: null }
        : { data: null, error: null }
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => Promise.resolve(result),
        // `await from('account_contacts').select().eq()` resolves to the rows
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
      }
      return chain
    },
  },
}))
vi.mock('@/lib/portal/entity-type-from-contract', () => ({ resolveEntityTypeForFormation: vi.fn() }))
vi.mock('@/lib/formation/state-lookup', () => ({ formationStateForClient: vi.fn() }))
vi.mock('@/lib/crm-store/formation-pilot', () => ({ pilotCompleteHandover: vi.fn(async () => null) }))
vi.mock('@/lib/operations/suite', () => ({ claimCompanySuite: vi.fn(async () => null) }))
vi.mock('@/lib/mcp/action-log', () => ({ logAction: vi.fn() }))
vi.mock('@/lib/team/reanchor-conversations', () => ({ reanchorLeadConversations: vi.fn() }))

import { preflightFormationMaterialization, materializeFormationCompany } from '@/lib/operations/formation-materialize'
import { resolveEntityTypeForFormation } from '@/lib/portal/entity-type-from-contract'
import { formationStateForClient } from '@/lib/formation/state-lookup'

const SUB = { id: 'sub-1', submitted_data: {}, upload_paths: [], state: 'NM', entity_type: 'SMLLC', created_at: '2026-10-19T10:00:00Z' }
const WP = (data: Record<string, unknown> = {}) => ({ id: 'wp-1', data, lead_id: null, created_at: '2026-10-01T10:00:00Z' })
const SMLLC = { wizardCode: 'SMLLC', accountLabel: 'Single Member LLC', source: 'contract', detail: 'signed contract' } as never
const UNRESOLVED = { wizardCode: null, accountLabel: null, source: 'unresolved', detail: 'No signed contract with llc_type' } as never

beforeEach(() => {
  state.rows = {}
  state.calls = []
  vi.mocked(resolveEntityTypeForFormation).mockReset().mockResolvedValue(SMLLC)
  vi.mocked(formationStateForClient).mockReset().mockResolvedValue('NM')
})

describe('preflight — the legal name the company would get', () => {
  it('"Tanto per" (the real case) -> "Tanto per LLC", reported as the legal name', async () => {
    state.rows = { sub: SUB, wp: WP() }
    const r = await preflightFormationMaterialization({ contact_id: 'c-1', chosen_name: 'Tanto per' })
    expect(r.ok).toBe(true)
    expect(r.legal_name).toBe('Tanto per LLC')
    expect(r.chosen_name).toBe('Tanto per LLC')
  })

  it('a staff-confirmed legal name wins, untouched ("Tanto Per LLC", the Articles spelling)', async () => {
    state.rows = { sub: SUB, wp: WP() }
    const r = await preflightFormationMaterialization({ contact_id: 'c-1', chosen_name: 'Tanto per', legal_name: 'Tanto Per LLC' })
    expect(r.ok).toBe(true)
    expect(r.legal_name).toBe('Tanto Per LLC')
  })

  it('wizard fallback "Salemark llc" -> "Salemark LLC" (the real lowercase case)', async () => {
    state.rows = { sub: null, wp: WP({ chosen_name_final: 'Salemark llc' }) }
    const r = await preflightFormationMaterialization({ contact_id: 'c-1' })
    expect(r.ok).toBe(true)
    expect(r.legal_name).toBe('Salemark LLC')
  })

  it('an existing valid ending is never doubled ("Acme L.L.C.")', async () => {
    state.rows = { sub: SUB, wp: WP() }
    const r = await preflightFormationMaterialization({ contact_id: 'c-1', chosen_name: 'Acme L.L.C.' })
    expect(r.legal_name).toBe('Acme L.L.C.')
  })

  it('a non-LLC ending is refused with a plain message and needs_legal_name — as a RETURNED failure, never a throw', async () => {
    state.rows = { sub: SUB, wp: WP() }
    const r = await preflightFormationMaterialization({ contact_id: 'c-1', chosen_name: 'Acme Inc' })
    expect(r.ok).toBe(false)
    expect(r.failure).toBe('invalid_name')
    expect(r.needs_legal_name).toBe(true)
    expect(r.error).toContain('not an LLC ending')
    expect(r.legal_name).toBeUndefined()
  })

  it('the name refusal does NOT hide the other blockers: state and name are reported together', async () => {
    state.rows = { sub: { ...SUB, state: null }, wp: WP({}) }
    vi.mocked(formationStateForClient).mockResolvedValue(null)
    const r = await preflightFormationMaterialization({ contact_id: 'c-1', chosen_name: 'Acme Corp' })
    expect(r.ok).toBe(false)
    expect(r.failure).toBe('invalid_state') // state stays the primary reason, as before
    expect(r.needs_state).toBe(true)
    expect(r.needs_legal_name).toBe(true)
    expect(r.error).toContain('No formation state captured')
    expect(r.error).toContain('not an LLC ending')
  })

  it('no name anywhere is still "missing_chosen_name" (unchanged)', async () => {
    state.rows = { sub: SUB, wp: WP({}) }
    const r = await preflightFormationMaterialization({ contact_id: 'c-1' })
    expect(r.failure).toBe('missing_chosen_name')
  })
})

describe('materializer — the same rule, and a retry never creates a second company', () => {
  const base = { contact_id: 'c-1', formation_state: 'NM' as const }

  it('refuses a non-LLC name with outcome invalid_name BEFORE any company is written', async () => {
    state.rows = { sub: SUB, wp: WP() }
    const r = await materializeFormationCompany({ ...base, chosen_name: 'Acme Inc' })
    expect(r.success).toBe(false)
    expect(r.outcome).toBe('invalid_name')
    expect(r.error).toContain('not an LLC ending')
    expect(state.calls).not.toContain('accounts')
  })

  it('RETRY: a company created BEFORE the fix as "Tanto per" is recognised as "Tanto per LLC" — already_materialized, no duplicate', async () => {
    state.rows = { sub: SUB, wp: WP(), links: [{ account_id: 'a-1', accounts: { id: 'a-1', company_name: 'Tanto per', status: 'Active' } }] }
    const r = await materializeFormationCompany({ ...base, chosen_name: 'Tanto per' })
    expect(r.outcome).toBe('already_materialized')
    expect(r.account_id).toBe('a-1')
    expect(state.calls).not.toContain('accounts')
  })

  it('RETRY with the Articles spelling: existing "Tanto Per LLC" matches filed "Tanto per" (capitals only)', async () => {
    state.rows = { sub: SUB, wp: WP(), links: [{ account_id: 'a-1', accounts: { id: 'a-1', company_name: 'Tanto Per LLC', status: 'Active' } }] }
    const r = await materializeFormationCompany({ ...base, chosen_name: 'Tanto per' })
    expect(r.outcome).toBe('already_materialized')
  })

  it('RETRY: staff-confirmed "TANTO PER, L.L.C." matches an existing "Tanto per LLC"', async () => {
    state.rows = { sub: SUB, wp: WP(), links: [{ account_id: 'a-1', accounts: { id: 'a-1', company_name: 'Tanto per LLC', status: 'Active' } }] }
    const r = await materializeFormationCompany({ ...base, chosen_name: 'Tanto per', legal_name: 'TANTO PER, L.L.C.' })
    expect(r.outcome).toBe('already_materialized')
  })

  it('a DIFFERENT company of the same person is not a retry (a different word) — creation goes on', async () => {
    vi.mocked(resolveEntityTypeForFormation).mockResolvedValue(UNRESOLVED)
    state.rows = { sub: { ...SUB, entity_type: null }, wp: WP(), links: [{ account_id: 'a-2', accounts: { id: 'a-2', company_name: 'Tanto Per Italia LLC', status: 'Active' } }] }
    const r = await materializeFormationCompany({ ...base, chosen_name: 'Tanto per' })
    expect(r.outcome).not.toBe('already_materialized') // it passed the duplicate check and stopped at the entity-type gate
    expect(r.outcome).toBe('missing_entity_type')
  })

  it('a Cancelled / Closed company with the same name does not block a new one', async () => {
    vi.mocked(resolveEntityTypeForFormation).mockResolvedValue(UNRESOLVED)
    state.rows = { sub: { ...SUB, entity_type: null }, wp: WP(), links: [{ account_id: 'a-3', accounts: { id: 'a-3', company_name: 'Tanto per LLC', status: 'Closed' } }] }
    const r = await materializeFormationCompany({ ...base, chosen_name: 'Tanto per' })
    expect(r.outcome).toBe('missing_entity_type')
  })

  it('the step log says the ending was added (so a guessed ending is visible, never silent)', async () => {
    vi.mocked(resolveEntityTypeForFormation).mockResolvedValue(UNRESOLVED)
    state.rows = { sub: { ...SUB, entity_type: null }, wp: WP() }
    const r = await materializeFormationCompany({ ...base, chosen_name: 'Tanto per' })
    const step = r.steps.find((s) => s.step === 'fetch_chosen_name')
    expect(step?.detail).toContain('Tanto per LLC')
    expect(step?.detail).toContain('LLC ending was added')
  })
})
