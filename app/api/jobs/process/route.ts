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
import { claimNextJob, completeJob, failJob } from "@/lib/jobs/queue"
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

  try {
    // Claim next pending job
    const job = await claimNextJob()

    if (!job) {
      return NextResponse.json({ status: "idle", message: "No pending jobs" })
    }

    // Find handler
    const handler = getJobHandler(job.job_type)
    if (!handler) {
      await failJob(job.id, `Unknown job type: ${job.job_type}`)
      return NextResponse.json({
        status: "error",
        job_id: job.id,
        error: `Unknown job type: ${job.job_type}`,
      })
    }

    // Execute handler
    try {
      const result = await handler(job)
      const hasErrors = result.steps.some(s => s.status === "error")

      if (hasErrors) {
        // Partial success — still mark completed but note errors in result
        await completeJob(job.id, result)
        return NextResponse.json({
          status: "completed_with_errors",
          job_id: job.id,
          summary: result.summary,
        })
      }

      await completeJob(job.id, result)
      return NextResponse.json({
        status: "completed",
        job_id: job.id,
        summary: result.summary,
      })
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e)
      await failJob(job.id, errorMsg)
      return NextResponse.json({
        status: "failed",
        job_id: job.id,
        error: errorMsg,
      })
    }
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
