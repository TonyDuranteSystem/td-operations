/**
 * Cron: Process Pending Jobs
 * Schedule: every 5 minutes (every-5-min cron)
 *
 * Safety net that picks up any jobs that failed during direct processing
 * in wizard-submit or were missed by the on-demand worker trigger.
 *
 * Uses the same claimNextJob() RPC as the worker endpoint (atomic claim,
 * prevents duplicate processing across concurrent cron invocations).
 *
 * Processes up to 10 jobs per run; each job runs sequentially within the
 * Vercel function's 300s window.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 300

import { NextRequest, NextResponse } from 'next/server'
import { claimNextJob, completeJob, failJob } from '@/lib/jobs/queue'
import { getJobHandler } from '@/lib/jobs/registry'
import { logCron } from '@/lib/cron-log'

const MAX_JOBS_PER_RUN = 10

export async function GET(req: NextRequest) {
  // Verify cron secret (Vercel sends this header)
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  const results: Array<{ job_id: string; job_type: string; status: string; summary?: string; error?: string }> = []

  for (let i = 0; i < MAX_JOBS_PER_RUN; i++) {
    // Claim next pending job atomically (prevents race conditions)
    let job
    try {
      job = await claimNextJob()
    } catch (e) {
      console.error('[process-jobs] claimNextJob failed:', e)
      break
    }

    if (!job) break // No more pending jobs

    const handler = getJobHandler(job.job_type)
    if (!handler) {
      await failJob(job.id, `Unknown job type: ${job.job_type}`)
      results.push({ job_id: job.id, job_type: job.job_type, status: 'failed', error: 'Unknown job type' })
      continue
    }

    try {
      const result = await handler(job)
      if (result.ok === false) {
        // Handler reached a failure path but chose not to throw. Move the
        // job to status='failed' so it shows up in the Exception Center's
        // Failed Jobs section instead of hiding inside a completed row.
        await failJob(job.id, result.summary || 'Handler reported failure', result)
        results.push({
          job_id: job.id,
          job_type: job.job_type,
          status: 'failed',
          summary: result.summary,
        })
      } else {
        await completeJob(job.id, result)
        results.push({
          job_id: job.id,
          job_type: job.job_type,
          status: result.steps.some(s => s.status === 'error') ? 'completed_with_errors' : 'completed',
          summary: result.summary,
        })
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      await failJob(job.id, errMsg)
      results.push({ job_id: job.id, job_type: job.job_type, status: 'failed', error: errMsg })
    }
  }

  const duration = Date.now() - startTime
  const processed = results.length

  logCron({
    endpoint: '/api/cron/process-jobs',
    status: processed === 0 ? 'success' : results.some(r => r.status === 'failed') ? 'error' : 'success',
    duration_ms: duration,
    details: { processed, results },
  })

  return NextResponse.json({
    processed,
    duration_ms: duration,
    results,
  })
}
