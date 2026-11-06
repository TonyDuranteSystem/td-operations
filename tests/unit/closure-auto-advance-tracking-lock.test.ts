/**
 * The automatic move when a step's last to-do is closed (checkAndAutoAdvance in lib/mcp/tools/crm.ts) writes the stage itself, so it must honour
 * the same IRS tracking-number lock as advanceServiceDelivery (step 4c). Bug-hunter 2026-11-05: production's "IRS Closure" has auto-advance ON and
 * five automatic to-dos, so closing them all moved the job on with no tracking number. (The "needs a document" rule is enforced by the database
 * itself and already holds on this path.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fx = vi.hoisted(() => ({
  serviceType: 'Company Closure',
  stage: 'IRS Closure',
  stageOrder: 4,
  missing: true,
  stageUpdates: [] as Array<Record<string, unknown>>,
}))

const layout = { components: [{ type: 'irs_tracking_entry', requiredToAdvance: true }] }
const closureSteps = [
  { service_type: 'Company Closure', stage_name: 'State Dissolution Filing', stage_order: 3, stage_layout: null, auto_advance: true, requires_approval: false, auto_tasks: [] },
  { service_type: 'Company Closure', stage_name: 'IRS Closure', stage_order: 4, stage_layout: layout, auto_advance: true, requires_approval: false, auto_tasks: [] },
  { service_type: 'Company Closure', stage_name: 'Waiting for the IRS', stage_order: 5, stage_layout: { components: [] }, auto_advance: false, requires_approval: false, auto_tasks: [] },
  { service_type: 'Company Closure', stage_name: 'Closing', stage_order: 6, stage_layout: null, auto_advance: true, requires_approval: false, auto_tasks: [] },
]
const plainSteps = [
  { service_type: 'Other', stage_name: 'One', stage_order: 1, stage_layout: null, auto_advance: true, requires_approval: false, auto_tasks: [] },
  { service_type: 'Other', stage_name: 'Two', stage_order: 2, stage_layout: null, auto_advance: true, requires_approval: false, auto_tasks: [] },
]

vi.mock('@/lib/operations/tracking-number-check', () => ({ trackingNumberMissing: async () => fx.missing }))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {}
      let wrote = false
      for (const m of ['select', 'eq', 'order', 'not', 'limit']) b[m] = () => b
      b.insert = () => Promise.resolve({ error: null })
      b.update = (row: Record<string, unknown>) => { wrote = true; if (table === 'service_deliveries') fx.stageUpdates.push(row); return b }
      b.single = () =>
        Promise.resolve(
          table === 'tasks'
            ? { data: { delivery_id: 'sd-1', stage_order: fx.stageOrder, status: 'Done' }, error: null }
            : table === 'service_deliveries'
              ? { data: { id: 'sd-1', service_name: 'Company Closure', service_type: fx.serviceType, stage: fx.stage, stage_order: fx.stageOrder, stage_history: [], status: 'active', account_id: null, deal_id: null }, error: null }
              : { data: closureSteps.concat(plainSteps).find((s) => s.service_type === fx.serviceType && s.stage_order === fx.stageOrder), error: null },
        )
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(
          wrote
            ? { error: null }
            : table === 'tasks'
              ? { count: 0, data: null, error: null } // no unfinished to-dos left on the step
              : { data: (fx.serviceType === 'Company Closure' ? closureSteps : plainSteps), error: null },
        ).then(res, rej)
      return b
    },
  },
}))
// the rest of the CRM tool file's imports are not exercised here
vi.mock('@/lib/sync-airtable', () => ({ syncSupabaseToAirtable: async () => undefined }))
vi.mock('@/lib/mcp/action-log', () => ({ logAction: async () => undefined }))
vi.mock('@/lib/operations/portal-login-email', () => ({ syncPortalLoginEmail: async () => undefined }))

import { checkAndAutoAdvance } from '@/lib/mcp/tools/crm'

beforeEach(() => {
  fx.serviceType = 'Company Closure'
  fx.stage = 'IRS Closure'
  fx.stageOrder = 4
  fx.missing = true
  fx.stageUpdates = []
})

describe('automatic move when the last to-do of a step is closed — the tracking lock', () => {
  it('"IRS Closure" with no tracking number saved: the job does NOT move, and the message says what is missing', async () => {
    const msg = await checkAndAutoAdvance('t-1')
    expect(msg).toContain('could not move to "Waiting for the IRS"')
    expect(msg).toContain('Enter the IRS mailing tracking number')
    expect(fx.stageUpdates).toEqual([])
  })

  it('"IRS Closure" with the tracking number saved: the job moves on as before', async () => {
    fx.missing = false
    const msg = await checkAndAutoAdvance('t-1')
    expect(fx.stageUpdates).toHaveLength(1)
    expect(fx.stageUpdates[0].stage).toBe('Waiting for the IRS')
    expect(msg ?? '').not.toContain('tracking number')
  })

  it('a step with no tracking lock is untouched: "State Dissolution Filing" moves on without any tracking number', async () => {
    fx.stage = 'State Dissolution Filing'
    fx.stageOrder = 3
    const msg = await checkAndAutoAdvance('t-1')
    expect(fx.stageUpdates).toHaveLength(1)
    expect(fx.stageUpdates[0].stage).toBe('IRS Closure')
    expect(msg ?? '').not.toContain('tracking number')
  })

  it('a different service with no flagged screen moves on exactly as before', async () => {
    fx.serviceType = 'Other'
    fx.stage = 'One'
    fx.stageOrder = 1
    await checkAndAutoAdvance('t-1')
    expect(fx.stageUpdates).toHaveLength(1)
    expect(fx.stageUpdates[0].stage).toBe('Two')
  })
})
