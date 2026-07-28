import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (preflight section) ──
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))
vi.mock('@/lib/portal/entity-type-from-contract', () => ({
  resolveEntityTypeForFormation: vi.fn(),
}))

import {
  selectFormationSource,
  preflightFormationMaterialization,
  type FormationSourceRows,
} from '@/lib/operations/formation-materialize'
import { resolveEntityTypeForFormation } from '@/lib/portal/entity-type-from-contract'
import { supabaseAdmin } from '@/lib/supabase-admin'
import type { AdvanceStageParams, AdvanceStageResult } from '@/lib/service-delivery'

// ─────────────────────────────────────────────────────────────────────────────
// selectFormationSource — PURE source decision (Covelli fix, council 2026-07-28)
// ─────────────────────────────────────────────────────────────────────────────

const SUB = (over: Partial<NonNullable<FormationSourceRows['sub']>> = {}): NonNullable<FormationSourceRows['sub']> => ({
  id: 'sub-1',
  submitted_data: { owner_first_name: 'Pat', entity_type: 'SMLLC' },
  upload_paths: ['formation/passport_owner.pdf'],
  state: 'NM',
  entity_type: 'SMLLC',
  created_at: '2026-07-17T10:00:00Z',
  ...over,
})

const WP = (over: Partial<NonNullable<FormationSourceRows['wp']>> = {}): NonNullable<FormationSourceRows['wp']> => ({
  id: 'wp-1',
  data: { chosen_name_final: 'DoctorGut LLC', passport: 'formation/wiz_passport.pdf' },
  lead_id: 'lead-1',
  created_at: '2026-06-09T10:00:00Z',
  ...over,
})

describe('selectFormationSource — pure source decision', () => {
  it('uses the submission when it is the only source', () => {
    const r = selectFormationSource({ sub: SUB(), wp: null })
    expect(r.resolverSource).toBe('formation_submissions')
    expect(r.submissionId).toBe('sub-1')
    expect(r.submissionEntityType).toBe('SMLLC')
    expect(r.submissionState).toBe('NM')
    expect(r.uploadPaths).toEqual(['formation/passport_owner.pdf'])
    expect(r.note).toBeNull()
  })

  it('uses the submission when it is newer than the current wizard run', () => {
    const r = selectFormationSource({
      sub: SUB({ created_at: '2026-07-17T10:00:00Z' }),
      wp: WP({ created_at: '2026-06-09T10:00:00Z' }),
    })
    expect(r.resolverSource).toBe('formation_submissions')
    expect(r.submissionEntityType).toBe('SMLLC')
  })

  it('RECENCY PIN: bypasses a submission that predates the current wizard run (returning client)', () => {
    const r = selectFormationSource({
      sub: SUB({ id: 'old-company-sub', created_at: '2026-01-01T10:00:00Z' }),
      wp: WP({ created_at: '2026-06-09T10:00:00Z', data: { entity_type: 'MMLLC' } }),
    })
    expect(r.resolverSource).toBe('wizard_progress')
    expect(r.submissionId).toBeNull()
    // The old company's data must NOT leak through.
    expect(r.submissionEntityType).toBe('MMLLC') // from wizard data, not the stale sub
    expect(r.note).toContain('old-company-sub')
    expect(r.note).toContain('predates')
  })

  it('does NOT treat missing timestamps as stale (pin requires both dates)', () => {
    const noSubDate = selectFormationSource({ sub: SUB({ created_at: null }), wp: WP() })
    expect(noSubDate.resolverSource).toBe('formation_submissions')
    const noWpDate = selectFormationSource({ sub: SUB(), wp: WP({ created_at: null }) })
    expect(noWpDate.resolverSource).toBe('formation_submissions')
  })

  it('wizard fallback extracts formation/ upload paths and entity_type from wizard data', () => {
    const r = selectFormationSource({
      sub: null,
      wp: WP({
        data: {
          entity_type: 'SMLLC',
          passport_owner: 'formation/abc/passport.jpg',
          note: 'not-a-path',
          other: 42,
        },
      }),
    })
    expect(r.resolverSource).toBe('wizard_progress')
    expect(r.uploadPaths).toEqual(['formation/abc/passport.jpg'])
    expect(r.submissionEntityType).toBe('SMLLC')
    expect(r.submissionState).toBeNull()
  })

  it('returns wizard shape with wp:null when NEITHER source exists (callers map to missing_submission)', () => {
    const r = selectFormationSource({ sub: null, wp: null })
    expect(r.resolverSource).toBe('wizard_progress')
    expect(r.wp).toBeNull()
    expect(r.submissionId).toBeNull()
  })

  it('tolerates a non-array upload_paths column', () => {
    const r = selectFormationSource({ sub: SUB({ upload_paths: 'oops' }), wp: null })
    expect(r.uploadPaths).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// preflightFormationMaterialization — deterministic dry-run gates
// ─────────────────────────────────────────────────────────────────────────────

/** Chainable mock for the two source reads. Records the status filter the
 *  formation_submissions query applies — the Covelli regression was exactly
 *  a completed-only read, so a revert must fail these tests. */
function installFrom(cfg: { sub?: unknown; wp?: unknown }) {
  const filters: {
    in: Array<[string, unknown]>
    eq: Array<[string, unknown]>
    order: Array<[string, unknown]>
  } = { in: [], eq: [], order: [] }
  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    const row = table === 'formation_submissions' ? cfg.sub : table === 'wizard_progress' ? cfg.wp : null
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        if (table === 'formation_submissions') filters.eq.push([col, val])
        return chain
      },
      in: (col: string, val: unknown) => {
        if (table === 'formation_submissions') filters.in.push([col, val])
        return chain
      },
      order: (col: string, opts: unknown) => {
        if (table === 'formation_submissions') filters.order.push([col, opts])
        return chain
      },
      limit: () => chain,
      maybeSingle: () => Promise.resolve({ data: row ?? null, error: null }),
    }
    return chain
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any)
  return filters
}

describe('preflightFormationMaterialization', () => {
  beforeEach(() => {
    vi.mocked(resolveEntityTypeForFormation).mockReset()
    vi.mocked(supabaseAdmin.from).mockReset()
  })

  it('reads submissions in BOTH lifecycle statuses (completed + reviewed) — the Covelli regression pin', async () => {
    const filters = installFrom({ sub: SUB(), wp: WP() })
    vi.mocked(resolveEntityTypeForFormation).mockResolvedValue({
      wizardCode: 'SMLLC', accountLabel: 'Single Member LLC', source: 'formation_submission', detail: 'from form',
    })
    await preflightFormationMaterialization({ contact_id: 'c-1', chosen_name: 'DoctorGut LLC' })
    expect(filters.in).toContainEqual(['status', ['completed', 'reviewed']])
    // And no completed-only equality filter on status.
    expect(filters.eq.filter(([col]) => col === 'status')).toEqual([])
    // NEWEST FIRST is load-bearing: an ascending order would let a stale
    // completed row from an older formation beat a newer reviewed one.
    expect(filters.order).toContainEqual(['created_at', { ascending: false }])
  })

  it('fails with missing_submission when neither a submission nor a wizard exists', async () => {
    installFrom({})
    const r = await preflightFormationMaterialization({ contact_id: 'c-1' })
    expect(r.ok).toBe(false)
    expect(r.failure).toBe('missing_submission')
  })

  it('fails with missing_chosen_name when no name is confirmed anywhere', async () => {
    installFrom({ sub: SUB(), wp: WP({ data: {} }) })
    const r = await preflightFormationMaterialization({ contact_id: 'c-1', chosen_name: null })
    expect(r.ok).toBe(false)
    expect(r.failure).toBe('missing_chosen_name')
  })

  it('fails with missing_entity_type when the resolver is unresolved, carrying its detail', async () => {
    installFrom({ sub: SUB({ entity_type: null }), wp: WP() })
    vi.mocked(resolveEntityTypeForFormation).mockResolvedValue({
      wizardCode: null, accountLabel: null, source: 'unresolved', detail: 'No signed contract with llc_type…',
    })
    const r = await preflightFormationMaterialization({ contact_id: 'c-1', chosen_name: 'DoctorGut LLC' })
    expect(r.ok).toBe(false)
    expect(r.failure).toBe('missing_entity_type')
    expect(r.error).toContain('No signed contract')
  })

  it('passes the REVIEWED submission entity_type into the resolver (the starved-resolver fix)', async () => {
    installFrom({ sub: SUB({ entity_type: 'SMLLC' }), wp: WP() })
    vi.mocked(resolveEntityTypeForFormation).mockResolvedValue({
      wizardCode: 'SMLLC', accountLabel: 'Single Member LLC', source: 'formation_submission', detail: 'from form',
    })
    const r = await preflightFormationMaterialization({ contact_id: 'c-1', chosen_name: 'DoctorGut LLC' })
    expect(r.ok).toBe(true)
    expect(r.entity_code).toBe('SMLLC')
    expect(vi.mocked(resolveEntityTypeForFormation).mock.calls[0][0]).toMatchObject({
      submissionEntityType: 'SMLLC',
    })
  })

  it('passes a staff entity_type override through as adminOverride', async () => {
    installFrom({ sub: null, wp: WP({ data: { chosen_name_final: 'X LLC' } }) })
    vi.mocked(resolveEntityTypeForFormation).mockResolvedValue({
      wizardCode: 'MMLLC', accountLabel: 'Multi Member LLC', source: 'admin_override', detail: 'admin',
    })
    const r = await preflightFormationMaterialization({ contact_id: 'c-1', entity_type: 'MMLLC' })
    expect(r.ok).toBe(true)
    expect(vi.mocked(resolveEntityTypeForFormation).mock.calls[0][0]).toMatchObject({
      adminOverride: 'MMLLC',
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Advance contract additions (type-level)
// ─────────────────────────────────────────────────────────────────────────────

describe('advance contract — entity_type param + structured materialization result', () => {
  it('AdvanceStageParams accepts the staff LLC-type override', () => {
    const p: AdvanceStageParams = {
      delivery_id: '00000000-0000-0000-0000-000000000001',
      target_stage: 'Articles Received',
      entity_type: 'SMLLC',
    }
    expect(p.entity_type).toBe('SMLLC')
  })

  it('AdvanceStageResult carries the structured materialization outcome', () => {
    const r: AdvanceStageResult = {
      success: true,
      from_stage: 'Filed with State',
      to_stage: 'Articles Received',
      to_order: 4,
      total_stages: 8,
      is_completed: false,
      created_tasks: [],
      failed_tasks: [],
      auto_triggers: [],
      materialization: { attempted: true, outcome: 'error', error: 'Drive timeout — the company record was NOT created.' },
    }
    expect(r.materialization?.error).toContain('NOT created')
  })
})
