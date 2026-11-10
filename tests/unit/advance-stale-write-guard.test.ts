import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Production end-to-end test 2026-11-10 (dev job a6bbea09): staff moved a closure job to IRS Closure, then a background step of the client's
 * form — which had read the job at "Data Collection" minutes earlier — finished and wrote its own move. The write had no condition, so it put the
 * job BACK to State Compliance Check and replaced the history with its own single entry. The shared move (advanceServiceDelivery) now writes only
 * when the job is still on the step it read; otherwise it changes nothing and says so. Same stand-in database as closure-close-company-guard.test.ts.
 */

vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))
vi.mock('@/lib/db', () => ({
  dbWrite: vi.fn(async (p: PromiseLike<{ data: unknown }>) => (await p).data),
  dbWriteSafe: vi.fn(async (p: PromiseLike<{ data: unknown; error: unknown }>) => await p),
}))
vi.mock('@/lib/mcp/action-log', () => ({ logAction: vi.fn() }))
vi.mock('@/lib/operations/formation-materialize', () => ({
  preflightFormationMaterialization: vi.fn(async () => ({ ok: true })),
  materializeFormationCompany: vi.fn(),
}))
vi.mock('@/lib/operations/close-company', () => ({
  applyCompanyClosure: vi.fn(async () => ({ alreadyClosed: false, lines: [], problems: [] })),
}))

import { advanceServiceDelivery, JOB_MOVED_MEANWHILE } from '@/lib/service-delivery'
import { supabaseAdmin } from '@/lib/supabase-admin'

let delivery: Record<string, unknown>

const STAGES = [
  { stage_name: 'State Compliance Check', stage_order: 2 },
  { stage_name: 'IRS Closure', stage_order: 4 },
  { stage_name: 'Waiting for the IRS', stage_order: 5 },
].map((s) => ({ requires_approval: false, sla_days: null, auto_tasks: null, completes_service: false, ...s }))

function installFrom(movedRows: number) {
  const writes: Array<{ table: string; row: unknown }> = []
  const filters: Array<[string, string, unknown]> = []
  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    const result = table === 'service_deliveries' ? delivery : null
    let updating = false
    const chain: Record<string, unknown> = {}
    const self = () => chain
    for (const m of ['select', 'neq', 'in', 'or', 'ilike', 'order', 'limit', 'contains']) chain[m] = self
    chain.eq = (c: string, v: unknown) => { filters.push([table, `eq:${c}`, v]); return chain }
    chain.is = (c: string, v: unknown) => { filters.push([table, `is:${c}`, v]); return chain }
    chain.single = () => Promise.resolve({ data: result, error: null })
    chain.maybeSingle = () => Promise.resolve({ data: result, error: null })
    chain.update = (row: unknown) => { writes.push({ table, row }); updating = true; return chain }
    chain.insert = (row: unknown) => { writes.push({ table, row }); return chain }
    chain.then = (resolve: (v: unknown) => unknown) => {
      const data = table === 'pipeline_stages' ? STAGES : updating && table === 'service_deliveries' ? Array.from({ length: movedRows }, () => ({ id: 'sd-1' })) : []
      return Promise.resolve({ data, error: null }).then(resolve)
    }
    return chain
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any)
  return { writes, filters }
}

function closureAt(stage: string | null, order: number) {
  delivery = {
    id: 'sd-1', service_type: 'Company Closure', service_name: 'Company Closure', stage, stage_order: order,
    stage_history: [{ from_stage: 'State Compliance Check', to_stage: 'IRS Closure', advanced_by: 'flow-action' }],
    status: 'active', account_id: null, contact_id: 'c-1', is_test: true,
  }
}

beforeEach(() => { vi.clearAllMocks() })

describe('a stage move is written only if the job is still where it was read', () => {
  it('the write is conditioned on the step that was read', async () => {
    closureAt('IRS Closure', 4)
    const { filters } = installFrom(1)
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Waiting for the IRS' })
    expect(res.success).toBe(true)
    expect(filters).toContainEqual(['service_deliveries', 'eq:stage', 'IRS Closure'])
    expect(filters).toContainEqual(['service_deliveries', 'eq:id', 'sd-1'])
  })

  it('an empty-text step is matched as that text (not mistaken for "no step")', async () => {
    closureAt('', 0)
    const { filters } = installFrom(1)
    await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'State Compliance Check' }).catch(() => null)
    expect(filters).toContainEqual(['service_deliveries', 'eq:stage', ''])
  })

  it('a job with no step yet is matched on "no step"', async () => {
    closureAt(null, 0)
    const { filters } = installFrom(1)
    await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'State Compliance Check' }).catch(() => null)
    expect(filters).toContainEqual(['service_deliveries', 'is:stage', null])
  })

  it('when the job moved meanwhile (the write matches nothing) NOTHING is changed and the caller is told so', async () => {
    closureAt('IRS Closure', 4)
    installFrom(0)
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'State Compliance Check' })
    expect(res.success).toBe(false)
    expect(res.error).toBe(JOB_MOVED_MEANWHILE)
    expect(res.from_stage).toBe('IRS Closure')
    expect(res.created_tasks).toEqual([])
  })
})
