import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * §4d — the required Suite step gate in advanceServiceDelivery (Antonio 2026-09-30).
 * A Company Formation cannot move past "Wizard Submitted", and a Client Onboarding cannot move past
 * "Review & CRM Setup", until the company's suite is issued / reserved or explicitly waived. The gate is keyed on the GATE
 * ORDER (so a forward JUMP cannot skip it) and never touches cases already past it, test deliveries, or other services.
 * The database rule on service_deliveries is the safety net for every other writer (tested against the sandbox database).
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
const getSuiteStepState = vi.fn()
vi.mock('@/lib/operations/suite', () => ({ getSuiteStepState: (...a: unknown[]) => getSuiteStepState(...a) }))

import { advanceServiceDelivery } from '@/lib/service-delivery'
import { supabaseAdmin } from '@/lib/supabase-admin'

let delivery: Record<string, unknown>
let stages: Array<Record<string, unknown>>

const FORMATION_STAGES = [
  { stage_name: 'Payment Confirmed', stage_order: 1 },
  { stage_name: 'Wizard Submitted', stage_order: 2 },
  { stage_name: 'Filed with State', stage_order: 3 },
  { stage_name: 'Articles Received', stage_order: 4 },
].map(s => ({ ...s, requires_approval: false, sla_days: null, auto_tasks: null }))

const ONBOARDING_STAGES = [
  { stage_name: 'Data Collection', stage_order: 1 },
  { stage_name: 'Review & CRM Setup', stage_order: 2 },
  { stage_name: 'Post-Review & Closing', stage_order: 3 },
].map(s => ({ ...s, requires_approval: false, sla_days: null, auto_tasks: null }))

function installFrom() {
  const writes: Array<{ table: string; op: 'update' | 'insert'; row: unknown }> = []
  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    const make = (result: unknown): Record<string, unknown> => {
      const chain: Record<string, unknown> = {}
      const self = () => chain
      for (const m of ['select', 'eq', 'neq', 'in', 'is', 'or', 'ilike', 'order', 'limit', 'contains']) chain[m] = self
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
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: table === 'pipeline_stages' ? stages : [], error: null }).then(resolve)
      return chain
    }
    if (table === 'service_deliveries') return make(delivery)
    if (table === 'pipeline_stages') return make(stages)
    return make(null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any)
  return writes
}

function formationAt(stage: string, order: number, extra: Record<string, unknown> = {}) {
  delivery = {
    id: 'sd-1', service_type: 'Company Formation', service_name: 'Company Formation', stage, stage_order: order,
    stage_history: [], status: 'active', account_id: null, contact_id: 'contact-1', name_checks: [], is_test: false, ...extra,
  }
  stages = FORMATION_STAGES
}

beforeEach(() => {
  vi.clearAllMocks()
  getSuiteStepState.mockReset()
})

describe('advanceServiceDelivery §4d — the required Suite step', () => {
  it('REFUSES Wizard Submitted -> Filed with State while the suite is neither issued nor waived, and writes nothing', async () => {
    formationAt('Wizard Submitted', 2)
    getSuiteStepState.mockResolvedValue({ satisfied: false })
    const writes = installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Filed with State' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Suite step/)
    expect(res.error).toMatch(/No suite for this client/)
    expect(writes.filter(w => w.table === 'service_deliveries' && w.op === 'update')).toHaveLength(0)
  })

  it('a forward JUMP past the gate (Wizard Submitted -> Articles Received) is refused too', async () => {
    formationAt('Wizard Submitted', 2)
    getSuiteStepState.mockResolvedValue({ satisfied: false })
    installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Articles Received' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Wizard Submitted/)
  })

  it('from Payment Confirmed straight to a later stage is refused as well (the gate is the ORDER, not one target name)', async () => {
    formationAt('Payment Confirmed', 1)
    getSuiteStepState.mockResolvedValue({ satisfied: false })
    installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Filed with State' })
    expect(res.success).toBe(false)
  })

  it('does NOT refuse once the suite step is satisfied (issued, reserved or waived)', async () => {
    formationAt('Wizard Submitted', 2)
    getSuiteStepState.mockResolvedValue({ satisfied: true })
    installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Filed with State' }).catch(() => null)
    expect(getSuiteStepState).toHaveBeenCalledWith('sd-1')
    expect(res?.error ?? '').not.toMatch(/Suite step/)
  })

  it('never touches a case already PAST the gate (the four formations in flight)', async () => {
    formationAt('Filed with State', 3)
    installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Articles Received' }).catch(() => null)
    expect(getSuiteStepState).not.toHaveBeenCalled()
    expect(res?.error ?? '').not.toMatch(/Suite step/)
  })

  it('test deliveries are exempt', async () => {
    formationAt('Wizard Submitted', 2, { is_test: true })
    installFrom()
    await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Filed with State' }).catch(() => null)
    expect(getSuiteStepState).not.toHaveBeenCalled()
  })

  it('a failed CHECK (transient read error) does not block — the database rule is still the net', async () => {
    formationAt('Wizard Submitted', 2)
    getSuiteStepState.mockRejectedValue(new Error('read timeout'))
    installFrom()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Filed with State' }).catch(() => null)
    expect(res?.error ?? '').not.toMatch(/Suite step/)
    warn.mockRestore()
  })

  it('Client Onboarding: refuses moving past "Review & CRM Setup" until the suite is decided', async () => {
    delivery = {
      id: 'sd-1', service_type: 'Client Onboarding', service_name: 'Client Onboarding', stage: 'Review & CRM Setup', stage_order: 2,
      stage_history: [], status: 'active', account_id: 'acct-1', contact_id: 'c1', is_test: false,
    }
    stages = ONBOARDING_STAGES
    getSuiteStepState.mockResolvedValue({ satisfied: false })
    installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Post-Review & Closing' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Review & CRM Setup/)
  })

  it('other services never consult the suite step', async () => {
    delivery = {
      id: 'sd-1', service_type: 'EIN', service_name: 'EIN', stage: 'A', stage_order: 1,
      stage_history: [], status: 'active', account_id: 'acct-1', contact_id: 'c1', is_test: false,
    }
    stages = [
      { stage_name: 'A', stage_order: 1, requires_approval: false, sla_days: null, auto_tasks: null },
      { stage_name: 'B', stage_order: 2, requires_approval: false, sla_days: null, auto_tasks: null },
    ]
    installFrom()
    await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'B' }).catch(() => null)
    expect(getSuiteStepState).not.toHaveBeenCalled()
  })
})
