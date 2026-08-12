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
  /** Phase 3R: the handler had NO usable window left (late claim) and handed
   *  its work to a continuation job. The RUNNER must stop claiming after this
   *  job — otherwise the same dying invocation immediately re-claims the
   *  continuation and no-op-spins until its budget ends (observed on prod:
   *  30 zero-batch relays per 2 real chunks). The next fresh invocation
   *  (cron ≤5 min / next trigger) claims it with a full window. */
  deferRunner?: boolean
  /**
   * Handler-reported outcome. `false` means this run reached a failure
   * path the handler chose NOT to throw on (validation refused, OCR
   * mismatch blocked the chain, a critical dependency was missing).
   *
   * The cron treats `ok === false` as a signal to move the job into
   * `status='failed'` instead of `'completed'` — so the Exception
   * Center's Failed Jobs section sees it, the Silent-Failed Jobs
   * safety net stays empty, and monitoring doesn't have to parse the
   * summary string.
   *
   * Omitted (undefined) or `true` → treated as success. Handlers that
   * partially succeed (e.g. "23 ok, 1 error, 2 skipped") leave it
   * undefined on purpose: some non-blocking step errors shouldn't
   * flip the whole job to failed.
   */
  ok?: boolean
  /**
   * With `ok:false`: this failure is PERMANENT — retrying cannot change the
   * outcome (an unreadable file, a wrong-year statement, a corrupt archive).
   * Both runners pass it through to failJob, which then FINAL-fails on the
   * first attempt instead of resetting to pending. Before this flag existed
   * (2026-08-12, card 4a39e0fd), every dead statement file was retried to
   * max_attempts, burning a full AI extraction per retry with an identical
   * result. Omitted → ok:false retries as before (transient-looking failures
   * keep their retry budget).
   */
  terminal?: boolean
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
 * Enqueue MANY jobs in one bulk insert + a SINGLE worker trigger.
 * Use this instead of looping enqueueJob() when queuing a batch (e.g. the
 * dunning pass) — it avoids N HTTP worker triggers. Returns the new job IDs.
 */
export async function enqueueJobs(
  jobs: Array<{
    job_type: string
    payload: JobPayload
    priority?: number
    max_attempts?: number
    account_id?: string
    lead_id?: string
    related_entity_type?: string
    related_entity_id?: string
    created_by?: string
  }>,
): Promise<{ ids: string[] }> {
  if (jobs.length === 0) return { ids: [] }

  const rows = jobs.map((j) => ({
    job_type: j.job_type,
    payload: j.payload as unknown as Json,
    priority: j.priority ?? 5,
    max_attempts: j.max_attempts ?? 3,
    account_id: j.account_id || null,
    lead_id: j.lead_id || null,
    related_entity_type: j.related_entity_type || null,
    related_entity_id: j.related_entity_id || null,
    created_by: j.created_by ?? "claude",
  }))

  const { data, error } = await supabaseAdmin.from("job_queue").insert(rows).select("id")
  if (error) throw new Error(`Failed to enqueue jobs: ${error.message}`)

  // One trigger for the whole batch; the safety-net cron drains the rest.
  triggerWorker().catch(() => {})

  return { ids: (data ?? []).map((r) => r.id) }
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
export async function failJob(
  jobId: string,
  errorMsg: string,
  result?: JobResult,
  opts?: {
    /** Skip the retry branch — the failure is permanent (JobResult.terminal). */
    terminal?: boolean
  },
): Promise<void> {
  // Get current attempts + the fields needed to notify the client if this is a
  // wizard job reaching its FINAL failed state (see wizard-failure-notify.ts).
  const { data: job } = await supabaseAdmin
    .from("job_queue")
    .select("attempts, max_attempts, job_type, account_id, payload")
    .eq("id", jobId)
    .single()

  const attempts = (job?.attempts ?? 0) + 1
  const maxAttempts = job?.max_attempts ?? 3

  if (!opts?.terminal && attempts < maxAttempts) {
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
    // Max attempts reached — mark as failed. The `.neq('status','failed')` is a
    // TOCTOU guard: only the FIRST caller to flip the job into 'failed' gets a
    // returned row, so the client notification below fires exactly once even if
    // two paths ever race to fail the same job.
    const { data: transitioned, error } = await supabaseAdmin
      .from("job_queue")
      .update({
        status: "failed",
        attempts,
        error: errorMsg,
        result: (result || undefined) as unknown as Json,
        completed_at: new Date().toISOString(),
      })
      .eq("id", jobId)
      .neq("status", "failed")
      .select("id")
    if (error) throw new Error(`failJob (final) failed: ${error.message}`)

    // Tell the client their submission hit a snag. AWAIT it (not fire-and-forget):
    // callers `await failJob()` and then immediately return the HTTP response, so a
    // detached promise would race the serverless function freezing after the
    // response is sent and the insert could be dropped — defeating the whole point.
    // notifyClientOfWizardJobFailure self-gates to wizard job types and never
    // throws (its own try/catch returns a result), so awaiting it here can never
    // break failJob; it only guarantees the message lands before we return. Gated
    // on the real transition (guard above) so a re-entrant call can't double-post.
    if ((transitioned?.length ?? 0) > 0) {
      try {
        const { notifyClientOfWizardJobFailure, notifyClientOfStatementIngestFailure } = await import("./wizard-failure-notify")
        const failedJob = {
          id: jobId,
          job_type: (job?.job_type as string | undefined) ?? "",
          account_id: (job?.account_id as string | null | undefined) ?? null,
          payload: (job?.payload as Record<string, unknown> | null | undefined) ?? null,
        }
        // Both self-gate on job_type, so calling both is safe; exactly one
        // (or neither) acts. Ingest failures gained their own notifier on
        // 2026-08-12 (card 4a39e0fd) — before that, a dead statement file
        // never told the client or staff anything.
        await notifyClientOfWizardJobFailure(failedJob)
        await notifyClientOfStatementIngestFailure(failedJob)
      } catch (e) {
        console.error(`[failJob] wizard failure notify error for ${jobId}:`, e)
      }
    }
  }
}

/**
 * Fire-and-forget trigger to the worker endpoint. Exported so the worker can
 * CHAIN — after finishing one job it pings itself to claim the next, draining a
 * batch of heavy jobs (e.g. per-file statement ingestion) one-by-one without
 * relying on the cron to loop many multi-minute jobs in a single 300s run.
 */
export async function triggerWorker(): Promise<void> {
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
