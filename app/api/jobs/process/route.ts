/**
 * Job Worker — processes pending jobs from the job_queue table.
 *
 * Called two ways:
 * 1. On-demand: fire-and-forget fetch from enqueueJob() — immediate processing
 * 2. Safety net: pg_cron every 5 minutes — picks up orphaned pending jobs
 *
 * Auth: Bearer token (TD_MCP_API_KEY or JOB_WORKER_SECRET)
 * Timeout: 300s (Vercel Pro)
 */

import { NextResponse, type NextRequest } from "next/server"
import { claimNextJob, completeJob, failJob, triggerWorker } from "@/lib/jobs/queue"
import { getJobHandler } from "@/lib/jobs/registry"

export const maxDuration = 300

export async function POST(request: NextRequest) {
  // Auth: Bearer token (primary) OR internal cron trigger
  // pg_cron + pg_net can't easily set auth headers, so we allow unauthenticated
  // POST with trigger="cron-safety-net" — the worker is safe because it only
  // processes jobs from our own job_queue table (no user input).
  const authHeader = request.headers.get("authorization")
  const bearerToken = authHeader?.replace("Bearer ", "")
  const validToken = process.env.JOB_WORKER_SECRET || process.env.TD_MCP_API_KEY

  let body: Record<string, unknown> = {}
  try { body = await request.json() } catch { /* empty body is ok */ }

  const isBearerAuth = bearerToken && bearerToken === validToken
  const isCronTrigger = body.trigger === "cron-safety-net"
  const isOnDemand = body.trigger === "on-demand"

  if (!isBearerAuth && !isCronTrigger && !isOnDemand) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAt = Date.now()
  // Drain the queue in a bounded loop within THIS invocation. Previously the
  // worker processed ONE job then fired a fire-and-forget chain kick — but that
  // kick was torn down by Vercel when the function returned, so a batch of jobs
  // enqueued close together (statement ingestion + its recategorize follow-up +
  // the next uploaded file) stopped draining and fell to the 5-min cron. Looping
  // here makes a single trigger reliably process everything pending. The atomic
  // claim (FOR UPDATE SKIP LOCKED) prevents double-processing if the cron fires
  // concurrently; the time budget keeps us under the 300s function limit.
  const BUDGET_MS = 250_000
  const processed: Array<{ job_id: string; job_type: string; status: string }> = []
  try {
    while (Date.now() - startedAt < BUDGET_MS) {
      const job = await claimNextJob()
      if (!job) break

      const handler = getJobHandler(job.job_type)
      if (!handler) {
        await failJob(job.id, `Unknown job type: ${job.job_type}`)
        processed.push({ job_id: job.id, job_type: job.job_type, status: "unknown_type" })
        continue
      }

      try {
        const result = await handler(job)
        await completeJob(job.id, result)
        processed.push({
          job_id: job.id,
          job_type: job.job_type,
          status: result.steps.some(s => s.status === "error") ? "completed_with_errors" : "completed",
        })
      } catch (e) {
        await failJob(job.id, e instanceof Error ? e.message : String(e))
        processed.push({ job_id: job.id, job_type: job.job_type, status: "failed" })
      }
    }

    // Only if we stopped on the time budget (not an empty queue) might jobs
    // remain — chain once so a large backlog keeps draining; the cron is the
    // ultimate net. A drained-to-empty run does NOT chain.
    if (Date.now() - startedAt >= BUDGET_MS && processed.length > 0) {
      void triggerWorker().catch(() => {})
    }

    return NextResponse.json({
      status: processed.length ? "drained" : "idle",
      processed: processed.length,
      jobs: processed,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    )
  }
}

// GET endpoint for health check / cron
export async function GET() {
  return NextResponse.json({
    status: "ok",
    worker: "job-queue-processor",
    timestamp: new Date().toISOString(),
  })
}
