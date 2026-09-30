import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * advanceFormationToStage must NEVER report a move that did not happen (Antonio 2026-09-30, review finding):
 * the database can refuse a move (the required Suite step is not done). Before this fix the update error was ignored,
 * the new stage's tasks were created, the action log said "advanced" and the caller reported success.
 */

vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))

import { advanceFormationToStage } from '@/lib/pipeline-utils'
import { supabaseAdmin } from '@/lib/supabase-admin'

const REFUSAL = 'Issue the company\'s suite (or tick "No suite for this client") before moving this case past "Wizard Submitted".'

let updateError: { message: string } | null
let writes: Array<{ table: string; op: string }>

function install() {
  writes = []
  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    const chain: Record<string, unknown> = {}
    const self = () => chain
    for (const m of ['select', 'eq', 'in', 'order', 'limit']) chain[m] = self
    chain.single = () =>
      Promise.resolve({
        data: table === 'service_deliveries'
          ? { id: 'sd-1', service_name: 'Company Formation', service_type: 'Company Formation', stage: 'Wizard Submitted', stage_order: 2, stage_history: [], deal_id: null, account_id: null }
          : null,
        error: null,
      })
    chain.update = () => {
      writes.push({ table, op: 'update' })
      return { eq: () => Promise.resolve({ error: updateError }) }
    }
    chain.insert = () => {
      writes.push({ table, op: 'insert' })
      return Promise.resolve({ error: null })
    }
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({
        data: table === 'pipeline_stages'
          ? [
              { stage_name: 'Wizard Submitted', stage_order: 2, auto_tasks: null },
              { stage_name: 'EIN Received', stage_order: 8, auto_tasks: [{ title: 'Welcome package' }] },
            ]
          : [],
        error: null,
      }).then(resolve)
    return chain
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any)
}

beforeEach(() => {
  vi.clearAllMocks()
  updateError = null
})

describe('advanceFormationToStage — a refused move is reported, not hidden', () => {
  it('returns advanced:false with the database message, creates no tasks, writes no "advanced" log', async () => {
    updateError = { message: REFUSAL }
    install()
    const res = await advanceFormationToStage('sd-1', 'EIN Received', 'crm-admin')
    expect(res.advanced).toBe(false)
    expect(res.detail).toBe(REFUSAL)
    expect(writes.filter(w => w.op === 'insert')).toHaveLength(0)
  })

  it('still advances, creates the stage tasks and logs when the database accepts the move', async () => {
    install()
    const res = await advanceFormationToStage('sd-1', 'EIN Received', 'crm-admin')
    expect(res.advanced).toBe(true)
    expect(writes.some(w => w.table === 'tasks' && w.op === 'insert')).toBe(true)
    expect(writes.some(w => w.table === 'action_log' && w.op === 'insert')).toBe(true)
  })
})
