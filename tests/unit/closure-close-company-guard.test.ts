import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Production end-to-end test 2026-11-07 (dev job eaa4747e): a move to a Company Closure job's last step CLOSES the company, and only the
 * workspace finish button used to ask first. The shared move (advanceServiceDelivery) now refuses such a move unless the caller says the
 * question was answered (company_close_confirmed) or the company is left open (skip_company_close) — so the step bar, the MCP tool and the
 * to-do card cannot close a company unasked. Same stand-in database as advance-c2-guards.test.ts.
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
  applyCompanyClosure: vi.fn(async () => ({ alreadyClosed: false, lines: ['Account → Closed'], problems: [] })),
}))

import { advanceServiceDelivery } from '@/lib/service-delivery'
import { applyCompanyClosure } from '@/lib/operations/close-company'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { COMPANY_CLOSE_NOT_CONFIRMED } from '@/lib/closure/closing-step'

let delivery: Record<string, unknown>

const CLOSURE = [
  { stage_name: 'IRS Closure', stage_order: 4 },
  { stage_name: 'Waiting for the IRS', stage_order: 5 },
  { stage_name: 'Closing', stage_order: 6, completes_service: true },
].map(s => ({ requires_approval: false, sla_days: null, auto_tasks: null, completes_service: false, ...s }))

function installFrom() {
  const writes: Array<{ table: string; row: unknown }> = []
  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    const result = table === 'service_deliveries' ? delivery : table === 'accounts' ? { is_test: true } : null
    const list = table === 'pipeline_stages' ? CLOSURE : []
    const chain: Record<string, unknown> = {}
    const self = () => chain
    for (const m of ['select', 'eq', 'neq', 'in', 'is', 'or', 'ilike', 'order', 'limit', 'contains']) chain[m] = self
    chain.single = () => Promise.resolve({ data: result, error: null })
    chain.maybeSingle = () => Promise.resolve({ data: result, error: null })
    chain.update = (row: unknown) => { writes.push({ table, row }); return chain }
    chain.insert = (row: unknown) => { writes.push({ table, row }); return chain }
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: list, error: null }).then(resolve)
    return chain
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any)
  return writes
}

function closureAt(stage: string, order: number, extra: Record<string, unknown> = {}) {
  delivery = {
    id: 'sd-1', service_type: 'Company Closure', service_name: 'Company Closure', stage, stage_order: order, stage_history: [],
    status: 'active', account_id: 'acct-1', contact_id: null, is_test: true, ...extra,
  }
}

const sdUpdates = (w: Array<{ table: string }>) => w.filter(x => x.table === 'service_deliveries')

beforeEach(() => { vi.clearAllMocks() })

describe('a move to Closing closes the company, so it is asked first', () => {
  it('is REFUSED with no answer (the step bar / tool / card used to close the company here), and writes nothing', async () => {
    closureAt('Waiting for the IRS', 5)
    const writes = installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Closing' })
    expect(res.success).toBe(false)
    expect(res.error).toBe(COMPANY_CLOSE_NOT_CONFIRMED)
    expect(sdUpdates(writes)).toHaveLength(0)
    expect(applyCompanyClosure).not.toHaveBeenCalled()
  })

  it('also refuses when the move JUMPS to Closing from an earlier step', async () => {
    closureAt('IRS Closure', 4)
    installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Closing' })
    expect(res.success).toBe(false)
    expect(res.error).toBe(COMPANY_CLOSE_NOT_CONFIRMED)
  })

  it('goes through when the question was answered yes, and closes the company', async () => {
    closureAt('Waiting for the IRS', 5)
    installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Closing', company_close_confirmed: true }).catch(() => null)
    expect(res?.error ?? '').not.toBe(COMPANY_CLOSE_NOT_CONFIRMED)
    expect(applyCompanyClosure).toHaveBeenCalledTimes(1)
  })

  it('goes through when the job is finished WITHOUT closing the company, and does not close it', async () => {
    closureAt('Waiting for the IRS', 5)
    installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Closing', skip_company_close: true }).catch(() => null)
    expect(res?.error ?? '').not.toBe(COMPANY_CLOSE_NOT_CONFIRMED)
    expect(applyCompanyClosure).not.toHaveBeenCalled()
  })

  it('a job with no company has nothing to close, so nothing to ask', async () => {
    closureAt('Waiting for the IRS', 5, { account_id: null })
    installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Closing' }).catch(() => null)
    expect(res?.error ?? '').not.toBe(COMPANY_CLOSE_NOT_CONFIRMED)
  })

  it('moving to an earlier step of the same job asks nothing', async () => {
    closureAt('IRS Closure', 4)
    installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Waiting for the IRS' }).catch(() => null)
    expect(res?.error ?? '').not.toBe(COMPANY_CLOSE_NOT_CONFIRMED)
  })
})
