/**
 * completeSD ("Mark complete") goes to the service's marked done step (N1a F1):
 * forward to it; refused when the job is already past it (a tax return on "Terminated - Non Payment" must not be
 * recorded as filed); refused when the service has no done step.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }))

let sdRow: Record<string, unknown> | null = null
let stageRows: Array<Record<string, unknown>> = []

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      const self = () => chain
      for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = self
      chain.single = () => Promise.resolve({ data: sdRow, error: null })
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: table === 'pipeline_stages' ? stageRows : [], error: null }).then(resolve)
      return chain
    },
  },
}))

const advance = vi.fn()
vi.mock('@/lib/service-delivery', () => ({ advanceServiceDelivery: (...a: unknown[]) => advance(...a) }))

import { completeSD } from '@/lib/operations/service-delivery'
import { NO_DONE_STEP_MESSAGE } from '@/lib/services/done-step'

const TAX = [
  { stage_name: 'Preparation', stage_order: 60, completes_service: false },
  { stage_name: 'TR Completed', stage_order: 70, completes_service: false },
  { stage_name: 'TR Filed', stage_order: 80, completes_service: true },
  { stage_name: 'Terminated - Non Payment', stage_order: 90, completes_service: false },
]

beforeEach(() => {
  advance.mockReset()
  advance.mockResolvedValue({ success: true })
})

describe('completeSD — Mark complete', () => {
  it('moves a tax return forward to "TR Filed", never to "Terminated - Non Payment"', async () => {
    sdRow = { service_type: 'Tax Return', stage: 'Preparation', stage_order: 60 }
    stageRows = TAX
    await completeSD({ delivery_id: 'sd-1' })
    expect(advance).toHaveBeenCalledWith(expect.objectContaining({ target_stage: 'TR Filed' }))
  })

  it('refuses a job already PAST its done step (terminated tax return) and moves nothing', async () => {
    sdRow = { service_type: 'Tax Return', stage: 'Terminated - Non Payment', stage_order: 90 }
    stageRows = TAX
    const res = await completeSD({ delivery_id: 'sd-1' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/already past its "done" step/)
    expect(advance).not.toHaveBeenCalled()
  })

  it('refuses a service with no done step (ITIN) and moves nothing', async () => {
    sdRow = { service_type: 'ITIN', stage: 'Data Collection', stage_order: 1 }
    stageRows = [
      { stage_name: 'Data Collection', stage_order: 1, completes_service: false },
      { stage_name: 'ITIN Approved', stage_order: 8, completes_service: false },
    ]
    const res = await completeSD({ delivery_id: 'sd-1' })
    expect(res.success).toBe(false)
    expect(res.error).toBe(NO_DONE_STEP_MESSAGE)
    expect(advance).not.toHaveBeenCalled()
  })

  it('passes the filing receipt through for Mark Filed', async () => {
    sdRow = { service_type: 'State RA Renewal', stage: 'Upcoming', stage_order: 1 }
    stageRows = [
      { stage_name: 'Upcoming', stage_order: 1, completes_service: false },
      { stage_name: 'Completed', stage_order: 3, completes_service: true },
    ]
    await completeSD({ delivery_id: 'sd-1', filing_receipt_document_id: 'doc-1', renewal_filing_for_year: 2026 })
    expect(advance).toHaveBeenCalledWith(expect.objectContaining({ target_stage: 'Completed', filing_receipt_document_id: 'doc-1' }))
  })

  it('before the migration (no flag on any step) keeps the old target: the highest-numbered step', async () => {
    sdRow = { service_type: 'State RA Renewal', stage: 'Upcoming', stage_order: 1 }
    stageRows = [{ stage_name: 'Upcoming', stage_order: 1 }, { stage_name: 'Completed', stage_order: 3 }]
    await completeSD({ delivery_id: 'sd-1' })
    expect(advance).toHaveBeenCalledWith(expect.objectContaining({ target_stage: 'Completed' }))
  })

  it('refuses a job that is already complete (N1a C2) — closing it again would repeat the renewal roll and notice', async () => {
    sdRow = { service_type: 'Tax Return', stage: 'TR Filed', stage_order: 80, status: 'completed' }
    stageRows = TAX
    const res = await completeSD({ delivery_id: 'sd-1' })
    expect(res.success).toBe(false)
    expect(res.error).toBe('This job is already complete.')
    expect(advance).not.toHaveBeenCalled()
  })

  it('closes an OPEN job already sitting on its done step without re-creating that step\'s tasks', async () => {
    sdRow = { service_type: 'Tax Return', stage: 'TR Filed', stage_order: 80, status: 'active' }
    stageRows = TAX
    await completeSD({ delivery_id: 'sd-1' })
    expect(advance).toHaveBeenCalledWith(expect.objectContaining({ target_stage: 'TR Filed', skip_tasks: true }))
  })

  it('a normal forward close still creates the done step\'s tasks', async () => {
    sdRow = { service_type: 'Tax Return', stage: 'Preparation', stage_order: 60, status: 'active' }
    stageRows = TAX
    await completeSD({ delivery_id: 'sd-1' })
    expect(advance.mock.calls[0][0]).not.toHaveProperty('skip_tasks')
  })

  it('refuses a cancelled job — reopen it first', async () => {
    sdRow = { service_type: 'Tax Return', stage: 'Preparation', stage_order: 60, status: 'cancelled' }
    stageRows = TAX
    const res = await completeSD({ delivery_id: 'sd-1' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/cancelled/)
    expect(advance).not.toHaveBeenCalled()
  })
})
