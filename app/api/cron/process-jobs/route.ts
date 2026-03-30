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
import { supabaseAdmin } from '@/lib/supabase-admin'
import { claimNextJob, completeJob, failJob } from '@/lib/jobs/queue'
import { getJobHandler } from '@/lib/jobs/registry'

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
      await completeJob(job.id, result)
      results.push({
        job_id: job.id,
        job_type: job.job_type,
        status: result.steps.some(s => s.status === 'error') ? 'completed_with_errors' : 'completed',
        summary: result.summary,
      })
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      await failJob(job.id, errMsg)
      results.push({ job_id: job.id, job_type: job.job_type, status: 'failed', error: errMsg })
    }
  }

  const duration = Date.now() - startTime
  const processed = results.length

  // Log to cron_log
  try {
    await supabaseAdmin.from('cron_log').insert({
      endpoint: '/api/cron/process-jobs',
      status: 'ok',
      error_message: processed === 0 ? 'No pending jobs' : null,
      executed_at: new Date().toISOString(),
    })
  } catch {
    // Non-fatal
  }

  return NextResponse.json({
    processed,
    duration_ms: duration,
    results,
  })
}
