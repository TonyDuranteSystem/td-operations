/**
 * Job worker drains the queue in a SINGLE invocation (bounded loop), instead of
 * one job + a fire-and-forget chain kick that Vercel tore down (leaving jobs to
 * the 5-min cron). Proves: a run processes ALL pending jobs, keeps going past a
 * failing one, and doesn't chain when it drained to empty.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { claimNextJob, completeJob, failJob, triggerWorker, getJobHandler } = vi.hoisted(() => ({
  claimNextJob: vi.fn(),
  completeJob: vi.fn().mockResolvedValue(undefined),
  failJob: vi.fn().mockResolvedValue(undefined),
  triggerWorker: vi.fn().mockResolvedValue(undefined),
  getJobHandler: vi.fn(),
}))

vi.mock('@/lib/jobs/queue', () => ({ claimNextJob, completeJob, failJob, triggerWorker }))
vi.mock('@/lib/jobs/registry', () => ({ getJobHandler }))

// eslint-disable-next-line import/first
import { POST } from '@/app/api/jobs/process/route'

const req = () =>
  new Request('http://localhost/api/jobs/process', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ trigger: 'on-demand' }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

describe('job worker — single-invocation drain', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('processes ALL pending jobs in one run, not just one', async () => {
    getJobHandler.mockReturnValue(vi.fn().mockResolvedValue({ steps: [], summary: 'ok' }))
    claimNextJob
      .mockResolvedValueOnce({ id: 'j1', job_type: 'ingest_bank_statement' })
      .mockResolvedValueOnce({ id: 'j2', job_type: 'ingest_bank_statement' })
      .mockResolvedValueOnce({ id: 'j3', job_type: 'recategorize_ai' })
      .mockResolvedValueOnce(null)

    const res = await POST(req())
    const body = await res.json()
    expect(completeJob).toHaveBeenCalledTimes(3)
    expect(body.processed).toBe(3)
    expect(body.status).toBe('drained')
    // drained to empty (not budget) → no overflow chain
    expect(triggerWorker).not.toHaveBeenCalled()
  })

  it('idle when the queue is empty', async () => {
    claimNextJob.mockResolvedValueOnce(null)
    const res = await POST(req())
    const body = await res.json()
    expect(body.status).toBe('idle')
    expect(completeJob).not.toHaveBeenCalled()
  })

  it('a failing job does not stop the drain', async () => {
    getJobHandler.mockReturnValue(
      vi.fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ steps: [], summary: 'ok' }),
    )
    claimNextJob
      .mockResolvedValueOnce({ id: 'j1', job_type: 't' })
      .mockResolvedValueOnce({ id: 'j2', job_type: 't' })
      .mockResolvedValueOnce(null)

    const res = await POST(req())
    const body = await res.json()
    expect(failJob).toHaveBeenCalledTimes(1)
    expect(completeJob).toHaveBeenCalledTimes(1)
    expect(body.processed).toBe(2)
  })
})
