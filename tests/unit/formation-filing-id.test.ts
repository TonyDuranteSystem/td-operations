/**
 * Job 64d2be64 — the state Filing ID staff confirm in the Articles upload window is SAVED on the company.
 * Real incident: the formation workspace read the filing date and the name from the Articles but never the Filing ID, so 19 of 19
 * companies created through it had an empty Filing ID and staff typed it by hand afterwards.
 *
 * The chain under test: upload window → upload route (refuses a junk ID) → advance (AdvanceStageParams.filing_id) → materializer
 * (new company: saved on insert; retry on an existing company: filled only when empty, never overwritten).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Link = { account_id: string; accounts: { id: string; company_name: string; status: string } }
const state = vi.hoisted(() => ({
  links: [] as Array<{ account_id: string; accounts: { id: string; company_name: string; status: string } }>,
  inserts: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ table: string; payload: Record<string, unknown>; orFilter?: string }>,
  filledRows: [{ id: 'a-1' }] as Array<{ id: string }>,
  updateError: null as null | { message: string },
}))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const result =
        table === 'formation_submissions' ? { data: { id: 'sub-1', submitted_data: {}, upload_paths: [], state: 'NM', entity_type: 'SMLLC', created_at: '2026-10-19T10:00:00Z' }, error: null }
        : table === 'wizard_progress' ? { data: { id: 'wp-1', data: {}, lead_id: null, created_at: '2026-10-01T10:00:00Z' }, error: null }
        : table === 'account_contacts' ? { data: state.links, error: null }
        : { data: null, error: null }
      let pendingUpdate: { table: string; payload: Record<string, unknown>; orFilter?: string } | null = null
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        or: (f: string) => { if (pendingUpdate) pendingUpdate.orFilter = f; return chain },
        maybeSingle: () => Promise.resolve(result),
        update: (payload: Record<string, unknown>) => {
          pendingUpdate = { table, payload }
          state.updates.push(pendingUpdate)
          return chain
        },
        // the new-company insert: capture the row, then stop the materializer right there (nothing after it is under test)
        insert: (row: Record<string, unknown>) => {
          if (table === 'accounts') state.inserts.push(row)
          return { select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'stop after the insert' } }) }) }
        },
        // `await …update().eq().or().select()` resolves to the rows the update touched
        then: (resolve: (v: unknown) => unknown) => {
          if (pendingUpdate && table === 'accounts') {
            return Promise.resolve({ data: state.updateError ? null : state.filledRows, error: state.updateError }).then(resolve)
          }
          return Promise.resolve(result).then(resolve)
        },
      }
      return chain
    },
  },
}))
vi.mock('@/lib/portal/entity-type-from-contract', () => ({
  resolveEntityTypeForFormation: vi.fn(async () => ({ wizardCode: 'SMLLC', accountLabel: 'Single Member LLC', source: 'contract', detail: 'signed contract' })),
}))
vi.mock('@/lib/formation/state-lookup', () => ({ formationStateForClient: vi.fn(async () => 'NM') }))
vi.mock('@/lib/crm-store/formation-pilot', () => ({ pilotCompleteHandover: vi.fn(async () => null) }))
vi.mock('@/lib/operations/suite', () => ({ claimCompanySuite: vi.fn(async () => null) }))
vi.mock('@/lib/mcp/action-log', () => ({ logAction: vi.fn(async () => undefined) }))
vi.mock('@/lib/team/reanchor-conversations', () => ({ reanchorLeadConversations: vi.fn() }))

import { materializeFormationCompany } from '@/lib/operations/formation-materialize'
import { logAction } from '@/lib/mcp/action-log'

const EXISTING: Link[] = [{ account_id: 'a-1', accounts: { id: 'a-1', company_name: 'Acme Holdings LLC', status: 'Active' } }]
const base = { contact_id: 'c-1', formation_state: 'NM' as const, chosen_name: 'Acme Holdings LLC' }

beforeEach(() => {
  state.links = []
  state.inserts = []
  state.updates = []
  state.filledRows = [{ id: 'a-1' }]
  state.updateError = null
  vi.mocked(logAction).mockClear()
})

describe('materializer — a NEW company is created with the confirmed Filing ID', () => {
  it('saves the Filing ID on the account row it inserts', async () => {
    await materializeFormationCompany({ ...base, filing_id: '2026-002103965', formation_date: '2026-10-12' })
    expect(state.inserts).toHaveLength(1)
    expect(state.inserts[0].filing_id).toBe('2026-002103965')
    expect(state.inserts[0].formation_date).toBe('2026-10-12')
  })

  it('without a confirmed Filing ID the company is created with none (null) — as before, never a made-up value', async () => {
    await materializeFormationCompany({ ...base })
    expect(state.inserts).toHaveLength(1)
    expect(state.inserts[0].filing_id).toBeNull()
  })
})

describe('materializer — a RETRY on an already-created company', () => {
  it('fills the Filing ID when the existing company has none, and says so in the step log + the action log', async () => {
    state.links = EXISTING
    const r = await materializeFormationCompany({ ...base, filing_id: '3190157', actor: 'flow-advance:flow-upload' })
    expect(r.outcome).toBe('already_materialized')
    expect(state.inserts).toHaveLength(0) // no second company
    const fill = state.updates.find((u) => u.table === 'accounts')
    expect(fill?.payload.filing_id).toBe('3190157')
    // fill-ONLY-when-empty: the update is guarded so a Filing ID already on the record is never overwritten
    expect(fill?.orFilter).toBe('filing_id.is.null,filing_id.eq.')
    expect(r.steps.find((s) => s.step === 'filing_id')).toMatchObject({ status: 'ok' })
    expect(vi.mocked(logAction)).toHaveBeenCalledWith(expect.objectContaining({ table_name: 'accounts', record_id: 'a-1', summary: 'filing_id updated' }))
  })

  it('leaves an existing Filing ID alone (the guarded update touches nothing) and says so', async () => {
    state.links = EXISTING
    state.filledRows = []
    const r = await materializeFormationCompany({ ...base, filing_id: '3190157' })
    expect(r.outcome).toBe('already_materialized')
    expect(r.steps.find((s) => s.step === 'filing_id')).toMatchObject({ status: 'skipped' })
    expect(vi.mocked(logAction)).not.toHaveBeenCalled()
  })

  it('a failed save is reported in the step log (never silent) and does not fail the retry', async () => {
    state.links = EXISTING
    state.updateError = { message: 'boom' }
    const r = await materializeFormationCompany({ ...base, filing_id: '3190157' })
    expect(r.success).toBe(true)
    expect(r.outcome).toBe('already_materialized')
    expect(r.steps.find((s) => s.step === 'filing_id')).toMatchObject({ status: 'error' })
    expect(r.steps.find((s) => s.step === 'filing_id')?.detail).toContain('boom')
  })

  it('no Filing ID supplied → the existing company is not touched at all', async () => {
    state.links = EXISTING
    const r = await materializeFormationCompany({ ...base })
    expect(r.outcome).toBe('already_materialized')
    expect(state.updates.filter((u) => u.table === 'accounts')).toHaveLength(0)
    expect(r.steps.find((s) => s.step === 'filing_id')).toBeUndefined()
  })
})

// The wiring between the layers (upload window → upload route → advance → materializer) is source-checked, the same way the
// other flow-upload tests pin their routes: each hop must carry the Filing ID, or the field silently stops reaching the company.
describe('the Filing ID travels every hop to the company', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

  it('the upload route refuses a junk ID with a plain sentence, then hands the cleaned one to the advance', () => {
    const route = read('app/api/flows/[id]/upload-document/route.ts')
    expect(route).toContain("normalizeFilingId(body.filing_id)")
    expect(route).toContain('can only contain letters, numbers and dashes')
    expect(route).toContain('status: 400')
    expect(route).toMatch(/advanceServiceDelivery\(\{[\s\S]*?filing_id: confirmedFilingId/)
  })

  it('the advance passes the Filing ID into the company creation', () => {
    const sd = read('lib/service-delivery.ts')
    expect(sd).toMatch(/filing_id\?: string/)
    expect(sd).toMatch(/materializeFormationCompany\(\{[\s\S]*?filing_id: params\.filing_id/)
  })

  it('the OCR prefill route returns the Filing ID read from the Articles', () => {
    const route = read('app/api/flows/[id]/articles-formation-date/route.ts')
    expect(route).toContain('parseFilingId(ocr.fullText)')
    expect(route).toContain('filing_id: filingId')
  })

  it('the upload window shows a State Filing ID field and sends the confirmed value', () => {
    const ui = read('components/flows/document-upload.tsx')
    expect(ui).toContain('data-testid="articles-filing-id"')
    expect(ui).toContain('filing_id: confirmedFilingId')
  })

  it('the old audit OCR route uses the ONE shared parser (no second copy)', () => {
    const route = read('app/api/crm/admin-actions/ocr-articles/route.ts')
    expect(route).toContain("from \"@/lib/articles-parse\"")
    expect(route).not.toContain('function parseArticlesText')
  })
})
