/**
 * closure.approve_data (the "Approve Data" button on the Company Closure to-do card) only belongs to "Data Collection". Bug-hunter 2026-11-05:
 * the card could be stale (or open in another tab) after the workspace moved the job, and the button would pull the job BACKWARD to
 * "State Compliance Check" and tell the client it moved. The handler now reads the job's real step first and refuses before saving anything.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fx = vi.hoisted(() => ({
  liveStage: 'Data Collection' as string | null,
  liveError: null as { message: string } | null,
  liveRow: true,
  applied: 0,
  advanced: 0,
}))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {}
      for (const m of ['select', 'eq', 'in', 'order', 'limit']) b[m] = () => b
      b.maybeSingle = () =>
        Promise.resolve(
          table === 'service_deliveries'
            ? { data: fx.liveRow ? { stage: fx.liveStage } : null, error: fx.liveError }
            : { data: { id: 'sub-1', account_id: null, contact_id: 'c-1', lead_id: null, status: 'completed', completed_at: null }, error: null },
        )
      return b
    },
  },
}))
vi.mock('@/lib/operations/closure-review', () => ({
  approveAndApplyClosureReview: async () => { fx.applied++; return { ok: true, alreadyApplied: false, drive_save: 'ok' } },
}))
vi.mock('@/lib/operations/service-delivery', () => ({
  advanceStage: async () => { fx.advanced++; return { success: true, from_stage: 'Data Collection', to_stage: 'State Compliance Check' } },
}))

import { closureApproveData } from '@/lib/tasks/workflow-handlers/closure-approve-data'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = (mode: 'preview' | 'execute' = 'execute'): any => ({
  mode,
  actor: { id: 'u-1' },
  task: { delivery_id: 'sd-1', account_id: null, contact_id: 'c-1', task_meta: { sd_stage: 'Data Collection' } },
})

beforeEach(() => {
  fx.liveStage = 'Data Collection'
  fx.liveError = null
  fx.liveRow = true
  fx.applied = 0
  fx.advanced = 0
})

describe('closure.approve_data — only from "Data Collection"', () => {
  it.each(['State Compliance Check', 'State Dissolution Filing', 'IRS Closure', 'Waiting for the IRS', 'Closing'])(
    'refuses when the job is already on "%s": nothing is saved and the job does not move',
    async (stage) => {
      fx.liveStage = stage
      const r = await closureApproveData(ctx())
      expect(r.success).toBe(false)
      expect(r.error?.code).toBe('WRONG_STAGE')
      expect(r.error?.message).toContain(stage)
      expect(fx.applied).toBe(0)
      expect(fx.advanced).toBe(0)
    },
  )

  it('refuses in preview as well, so the card never promises a move the button will refuse', async () => {
    fx.liveStage = 'IRS Closure'
    const r = await closureApproveData(ctx('preview'))
    expect(r.success).toBe(false)
    expect(r.error?.code).toBe('WRONG_STAGE')
  })

  it('works as before on "Data Collection": the review is saved and the job moves one step', async () => {
    const r = await closureApproveData(ctx())
    expect(r.success).toBe(true)
    expect(fx.applied).toBe(1)
    expect(fx.advanced).toBe(1)
  })

  it('a job that cannot be read, or is gone, stops with its own code (nothing saved)', async () => {
    fx.liveError = { message: 'boom' }
    const a = await closureApproveData(ctx())
    expect(a.error?.code).toBe('SD_LOOKUP_FAILED')
    expect(a.error?.message).toContain('boom')
    fx.liveError = null
    fx.liveRow = false
    const b = await closureApproveData(ctx())
    expect(b.error?.code).toBe('SD_LOOKUP_FAILED')
    expect(fx.applied).toBe(0)
    expect(fx.advanced).toBe(0)
  })
})
