import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Runtime pin for the §4b materialize-preflight REFUSAL gate in
 * advanceServiceDelivery (Covelli/DoctorGut fix, 2026-07-28): a Company
 * Formation advance into "Articles Received" with a deterministic
 * materialization blocker must be REFUSED before any stage write — deleting
 * the gate block makes these tests fail (bug-hunter demanded a runtime pin;
 * the type-level tests alone could not catch a gate removal).
 */

vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))
vi.mock('@/lib/db', () => ({
  dbWrite: vi.fn(async (p: PromiseLike<{ data: unknown }>) => (await p).data),
  dbWriteSafe: vi.fn(async (p: PromiseLike<{ data: unknown; error: unknown }>) => await p),
}))
vi.mock('@/lib/mcp/action-log', () => ({ logAction: vi.fn() }))
vi.mock('@/lib/operations/formation-materialize', () => ({
  preflightFormationMaterialization: vi.fn(),
  materializeFormationCompany: vi.fn(),
}))

import { advanceServiceDelivery } from '@/lib/service-delivery'
import { preflightFormationMaterialization } from '@/lib/operations/formation-materialize'
import { supabaseAdmin } from '@/lib/supabase-admin'

const DELIVERY = {
  id: 'sd-1',
  service_type: 'Company Formation',
  service_name: 'Company Formation',
  stage: 'Filed with State',
  stage_order: 3,
  stage_history: [],
  status: 'active',
  account_id: null,
  contact_id: 'contact-1',
  name_checks: [],
}

const STAGES = [
  { stage_name: 'Filed with State', stage_order: 3, requires_approval: false, sla_days: null, auto_tasks: null },
  { stage_name: 'Articles Received', stage_order: 4, requires_approval: false, sla_days: null, auto_tasks: null },
]

/** Universal thenable chain mock: every builder resolves {data,error} and
 *  records update/insert calls per table so the tests can assert NO stage
 *  write happened on a refusal. */
function installFrom() {
  const writes: Array<{ table: string; op: 'update' | 'insert'; row: unknown }> = []
  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    const make = (result: unknown): Record<string, unknown> => {
      const chain: Record<string, unknown> = {}
      const self = () => chain
      for (const m of ['select', 'eq', 'neq', 'in', 'is', 'or', 'ilike', 'order', 'limit', 'contains']) {
        chain[m] = self
      }
      chain.single = () => Promise.resolve({ data: result, error: null })
      chain.maybeSingle = () => Promise.resolve({ data: result, error: null })
      chain.update = (row: unknown) => {
        writes.push({ table, op: 'update', row })
        return chain
      }
      chain.insert = (row: unknown) => {
        writes.push({ table, op: 'insert', row })
        return chain
      }
      // Thenable: `await builder` anywhere resolves cleanly.
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: table === 'pipeline_stages' ? STAGES : [], error: null }).then(resolve)
      return chain
    }
    if (table === 'service_deliveries') return make(DELIVERY)
    if (table === 'pipeline_stages') return make(STAGES)
    return make(null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any)
  return writes
}

describe('advanceServiceDelivery §4b — deterministic materialization refusal gate', () => {
  beforeEach(() => {
    vi.mocked(supabaseAdmin.from).mockReset()
    vi.mocked(preflightFormationMaterialization).mockReset()
  })

  it('REFUSES the advance into "Articles Received" on a deterministic preflight failure — no stage write', async () => {
    const writes = installFrom()
    vi.mocked(preflightFormationMaterialization).mockResolvedValue({
      ok: false,
      failure: 'missing_entity_type',
      error: 'No signed contract with llc_type, no formation-form entity_type, and no wizard entity_type.',
    })

    const r = await advanceServiceDelivery({
      delivery_id: 'sd-1',
      target_stage: 'Articles Received',
      actor: 'test',
    })

    expect(r.success).toBe(false)
    expect(r.error).toContain('Cannot create the company record')
    expect(r.error).toContain('Choose the LLC type')
    // The refusal must happen BEFORE the stage-history write commits.
    expect(writes.filter((w) => w.table === 'service_deliveries')).toEqual([])
  })

  it('passes the staff entity_type override into the preflight', async () => {
    installFrom()
    vi.mocked(preflightFormationMaterialization).mockResolvedValue({
      ok: false,
      failure: 'missing_chosen_name',
      error: 'No confirmed company name yet.',
    })

    const r = await advanceServiceDelivery({
      delivery_id: 'sd-1',
      target_stage: 'Articles Received',
      entity_type: 'MMLLC',
      actor: 'test',
    })

    expect(r.success).toBe(false)
    expect(vi.mocked(preflightFormationMaterialization).mock.calls[0][0]).toMatchObject({
      contact_id: 'contact-1',
      entity_type: 'MMLLC',
    })
  })
})
