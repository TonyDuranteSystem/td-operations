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
import { supabaseAdmin } from '@/lib/supabase-admin'

const MAX_JOBS_PER_RUN = 10
// Stop CLAIMING new jobs once this much of the 300s window is spent. A single
// heavy job (a PDF statement ingest can run ~250s) must be able to finish
// inside the remaining budget — otherwise the function is killed mid-job and
// the job is orphaned in 'processing'. Draining a large batch fast is the
// on-demand worker's chain job; this cron is only the safety net.
const CLAIM_BUDGET_MS = 50_000
// A job still 'processing' past this is presumed dead (worker killed mid-run).
const STUCK_AFTER_MS = 15 * 60 * 1000

/**
 * Recover jobs orphaned in 'processing' (worker killed mid-run). claim_next_job
 * only ever picks 'pending', so without this a killed job hangs forever. Requeue
 * those with retries left; fail the rest so they surface in the Exception
 * Center instead of hiding as a stale 'processing' row.
 */
async function reapStuckJobs(): Promise<{ requeued: number; failed: number }> {
  const cutoff = new Date(Date.now() - STUCK_AFTER_MS).toISOString()
  const { data: stuck } = await supabaseAdmin
    .from('job_queue')
    .select('id, attempts, max_attempts')
    .eq('status', 'processing')
    .lt('started_at', cutoff)
  if (!stuck || stuck.length === 0) return { requeued: 0, failed: 0 }
  const toRetry = stuck.filter(j => (j.attempts ?? 0) < (j.max_attempts ?? 3)).map(j => j.id)
  const toFail = stuck.filter(j => (j.attempts ?? 0) >= (j.max_attempts ?? 3)).map(j => j.id)
  if (toRetry.length > 0) {
    await supabaseAdmin.from('job_queue')
      .update({ status: 'pending', started_at: null, error: 'Reaped: stuck in processing — requeued' })
      .in('id', toRetry)
  }
  if (toFail.length > 0) {
    await supabaseAdmin.from('job_queue')
      .update({ status: 'failed', completed_at: new Date().toISOString(), error: 'Reaped: stuck in processing past max_attempts' })
      .in('id', toFail)
  }
  return { requeued: toRetry.length, failed: toFail.length }
}

export async function GET(req: NextRequest) {
  // Verify cron secret (Vercel sends this header)
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  const reaped = await reapStuckJobs()
  // Self-healing AI chains (Phase 3R): revive dropped batons / retry halted
  // chains on the backoff ladder / alert staff on exhaustion. Runs BEFORE the
  // claim loop so this invocation can claim its own revival (deadline is
  // invocation-anchored, so a late claim is safe). Never blocks job processing.
  let watchdog: import('@/lib/jobs/chain-watchdog').WatchdogResult | null = null
  try {
    const { runChainWatchdog } = await import('@/lib/jobs/chain-watchdog')
    watchdog = await runChainWatchdog(startTime)
  } catch (e) {
    console.error('[process-jobs] chain watchdog failed (job processing continues):', e)
  }
  const results: Array<{ job_id: string; job_type: string; status: string; summary?: string; error?: string }> = []

  for (let i = 0; i < MAX_JOBS_PER_RUN; i++) {
    // Don't START a job we can't FINISH inside the function window.
    if (Date.now() - startTime > CLAIM_BUDGET_MS) break
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
      // Phase 3R: invocation-anchored deadline (chunked handlers stop cleanly).
      const result = await handler(job, { deadlineAt: startTime + 280_000 })
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
    details: { processed, results, reaped, watchdog },
  })

  return NextResponse.json({
    processed,
    reaped,
    watchdog,
    duration_ms: duration,
    results,
  })
}
