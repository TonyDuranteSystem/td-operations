/**
 * Job Queue — Core functions for creating and managing async jobs.
 * Used by MCP tools to enqueue work and by the worker to process it.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import type { Json } from "@/lib/database.types"

export interface JobPayload {
  [key: string]: unknown
}

export interface JobResult {
  steps: Array<{
    name: string
    status: "ok" | "error" | "skipped"
    detail?: string
    timestamp: string
  }>
  summary?: string
}

export interface Job {
  id: string
  job_type: string
  payload: JobPayload
  status: "pending" | "processing" | "completed" | "failed" | "cancelled"
  priority: number
  result: JobResult | null
  error: string | null
  attempts: number
  max_attempts: number
  created_at: string
  started_at: string | null
  completed_at: string | null
  created_by: string
  account_id: string | null
  lead_id: string | null
  related_entity_type: string | null
  related_entity_id: string | null
}

/**
 * Enqueue a new job. Returns the job ID.
 * After inserting, fires the worker in fire-and-forget mode.
 */
export async function enqueueJob(params: {
  job_type: string
  payload: JobPayload
  priority?: number
  max_attempts?: number
  account_id?: string
  lead_id?: string
  related_entity_type?: string
  related_entity_id?: string
  created_by?: string
}): Promise<{ id: string }> {
  const { data, error } = await supabaseAdmin
    .from("job_queue")
    .insert({
      job_type: params.job_type,
      payload: params.payload as unknown as Json,
      priority: params.priority ?? 5,
      max_attempts: params.max_attempts ?? 3,
      account_id: params.account_id || null,
      lead_id: params.lead_id || null,
      related_entity_type: params.related_entity_type || null,
      related_entity_id: params.related_entity_id || null,
      created_by: params.created_by ?? "claude",
    })
    .select("id")
    .single()

  if (error || !data) throw new Error(`Failed to enqueue job: ${error?.message}`)

  // Fire-and-forget: trigger the worker
  triggerWorker().catch(() => {
    // Swallow errors — safety net cron will pick it up
  })

  return { id: data.id }
}

/**
 * Claim the next pending job for processing.
 * Uses an atomic UPDATE ... RETURNING to prevent race conditions.
 */
export async function claimNextJob(): Promise<Job | null> {
  const { data, error } = await supabaseAdmin.rpc("claim_next_job")
  if (error) throw new Error(`claim_next_job failed: ${error.message}`)
  if (!data || (Array.isArray(data) && data.length === 0)) return null
  return (Array.isArray(data) ? data[0] : data) as unknown as Job
}

/**
 * Update job result after each step (incremental progress).
 */
export async function updateJobProgress(jobId: string, result: JobResult): Promise<void> {
  const { error } = await supabaseAdmin
    .from("job_queue")
    .update({ result: result as unknown as Json })
    .eq("id", jobId)
  if (error) throw new Error(`updateJobProgress failed: ${error.message}`)
}

/**
 * Mark job as completed.
 */
export async function completeJob(jobId: string, result: JobResult): Promise<void> {
  const { error } = await supabaseAdmin
    .from("job_queue")
    .update({
      status: "completed",
      result: result as unknown as Json,
      completed_at: new Date().toISOString(),
    })
    .eq("id", jobId)
  if (error) throw new Error(`completeJob failed: ${error.message}`)
}

/**
 * Mark job as failed.
 */
export async function failJob(jobId: string, errorMsg: string, result?: JobResult): Promise<void> {
  // Get current attempts
  const { data: job } = await supabaseAdmin
    .from("job_queue")
    .select("attempts, max_attempts")
    .eq("id", jobId)
    .single()

  const attempts = (job?.attempts ?? 0) + 1
  const maxAttempts = job?.max_attempts ?? 3

  if (attempts < maxAttempts) {
    // Reset to pending for retry
    const { error } = await supabaseAdmin
      .from("job_queue")
      .update({
        status: "pending",
        attempts,
        error: errorMsg,
        result: (result || undefined) as unknown as Json,
        started_at: null,
      })
      .eq("id", jobId)
    if (error) throw new Error(`failJob (retry) failed: ${error.message}`)
  } else {
    // Max attempts reached — mark as failed
    const { error } = await supabaseAdmin
      .from("job_queue")
      .update({
        status: "failed",
        attempts,
        error: errorMsg,
        result: (result || undefined) as unknown as Json,
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId)
    if (error) throw new Error(`failJob (final) failed: ${error.message}`)
  }
}

/**
 * Fire-and-forget trigger to the worker endpoint.
 */
async function triggerWorker(): Promise<void> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000")

  const workerUrl = `${baseUrl}/api/jobs/process`
  const secret = process.env.JOB_WORKER_SECRET || process.env.TD_MCP_API_KEY

  await fetch(workerUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify({ trigger: "on-demand" }),
    signal: AbortSignal.timeout(5000), // 5s timeout for the trigger call
  })
}
