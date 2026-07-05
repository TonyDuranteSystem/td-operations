/**
 * Job Handler: recategorize_ai (Phase 3R — chained chunks; client twin of
 * recategorize_workspace_ai).
 *
 * One invocation = ONE CHUNK against the account+tax_year scope. Same chain
 * rules as the workspace handler (see its header); the ONLY differences are
 * the scope guard — keyed on account_id + payload->>tax_year (this job type
 * sets no related_entity_id; UNQUOTED JSONB path per the documented PostgREST
 * gotcha) — and the run-record columns.
 *
 * WHY THE JOB EXISTS (prod bug, 2026-06-26): the AI pass used to run as a
 * dangling promise that Vercel tore down mid-flight. Now it's awaited in the
 * worker; Phase 3R additionally lets it span as many worker windows as needed.
 */

import type { Job, JobResult } from "../queue"
import type { JobRunContext } from "../registry"
import { AI_CHAIN_CHUNK_CAP, AI_CHAIN_JOB_PRIORITY, decideChunkFollowup } from "../chain-state"

interface RecategorizeAiPayload {
  account_id: string
  tax_year: number
  chunk_index?: number
  auto_retry?: number
}

function step(name: string, status: "ok" | "error" | "skipped", detail?: string) {
  return { name, status, detail, timestamp: new Date().toISOString() }
}

export async function handleRecategorizeAi(job: Job, ctx?: JobRunContext): Promise<JobResult> {
  const p = job.payload as unknown as RecategorizeAiPayload
  const result: JobResult = { steps: [] }
  const chunkIndex = p.chunk_index ?? 0

  if (!p.account_id || !Number.isInteger(p.tax_year)) {
    result.steps.push(step("validate", "error", "Missing account_id or tax_year"))
    result.ok = false
    result.summary = "Invalid recategorize_ai payload"
    return result
  }

  const { recategorizeAccountYear } = await import("@/lib/tax/categorization-engine")
  const r = await recategorizeAccountYear(p.account_id, p.tax_year, {
    aiAssist: true,
    aiOptions: ctx?.deadlineAt ? { deadlineAt: ctx.deadlineAt } : undefined,
  })

  const progressed = r.aiCategorized + r.aiStats.suggestionsParsed > 0
  const followup = decideChunkFollowup({
    stoppedOnDeadline: r.aiStats.stoppedOnDeadline === true,
    batchesSent: r.aiStats.batchesSent,
    batchesFailed: r.aiStats.batchesFailed,
    progressed,
    chunkIndex,
    noCandidates: r.aiNoCandidates === true,
  })

  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  // Per-chunk observability record — BEFORE the continuation insert; never fails the job.
  try {
    const { AI_MODEL, AI_PROMPT_VERSION } = await import("@/lib/tax/ai-categorizer")
    await db.from("ai_categorization_runs").insert({
      account_id: p.account_id,
      tax_year: p.tax_year,
      model: AI_MODEL,
      prompt_version: AI_PROMPT_VERSION,
      batches_sent: r.aiStats.batchesSent,
      batches_failed: r.aiStats.batchesFailed,
      truncated_batches: r.aiStats.truncatedBatches,
      suggestions_parsed: r.aiStats.suggestionsParsed,
      applied: r.aiCategorized,
      labeled: r.aiStats.suggestionsParsed,
      uncategorized_remaining: r.uncategorizedRemaining,
      capped: r.aiStats.capped,
      errors: [...r.aiErrors, `chunk=${chunkIndex}`, `followup=${followup}`],
    })
  } catch (e) {
    console.error("[recategorize-ai] run-record insert failed (job result unaffected):", e)
  }

  if (followup === "continue") {
    try {
      const { data: live } = await db
        .from("job_queue")
        .select("id")
        .eq("job_type", "recategorize_ai")
        .eq("account_id", p.account_id)
        .eq("payload->>tax_year", String(p.tax_year))
        .in("status", ["pending", "processing"])
        .neq("id", job.id)
        .limit(1)
      if (!live || live.length === 0) {
        // Zero-batch (late-claim) chunks don't consume cap fuel.
        const nextChunkIndex = r.aiStats.batchesSent > 0 ? chunkIndex + 1 : chunkIndex
        const { error } = await db.from("job_queue").insert({
          job_type: "recategorize_ai",
          payload: { account_id: p.account_id, tax_year: p.tax_year, chunk_index: nextChunkIndex, auto_retry: 0 },
          priority: AI_CHAIN_JOB_PRIORITY,
          account_id: p.account_id,
          created_by: "chain",
        })
        if (error) throw new Error(error.message)
        result.steps.push(step("chain_continuation", "ok", `chunk ${nextChunkIndex} enqueued${r.aiStats.batchesSent === 0 ? " (late claim — no work attempted, baton passed)" : ""}`))
      } else {
        result.steps.push(step("chain_continuation", "skipped", "another chain job already live"))
      }
    } catch (e) {
      console.error("[recategorize-ai] continuation insert failed (watchdog will revive):", e)
      result.steps.push(step("chain_continuation", "error", e instanceof Error ? e.message : String(e)))
    }
  }

  result.steps.push(step("ai_categorize", followup === "halt_no_progress" ? "error" : "ok",
    `chunk=${chunkIndex}, followup=${followup}, aiCategorized=${r.aiCategorized}, recategorized=${r.recategorized}, uncategorizedRemaining=${r.uncategorizedRemaining}${r.aiErrors.length ? `, aiErrors=${r.aiErrors.length}` : ""}`))

  if (followup === "halt_no_progress") {
    result.ok = false
    result.summary = `AI chunk made no progress (${r.aiStats.batchesSent} batches, ${r.aiStats.batchesFailed} failed) — chain halted (${p.account_id} ${p.tax_year})`
    return result
  }
  if (followup === "halt_cap") {
    result.ok = false
    result.summary = `AI chain hit the ${AI_CHAIN_CHUNK_CAP}-chunk cap with work remaining (${p.account_id} ${p.tax_year})`
    return result
  }
  if (followup === "continue" && r.aiStats.batchesSent === 0) {
    // Late-claim relay: no usable window left — stop this runner's claim loop
    // so the continuation waits for a fresh window (see workspace twin).
    result.deferRunner = true
  }
  result.summary = followup === "continue"
    ? `AI chunk ${chunkIndex} done — continuing (${p.account_id} ${p.tax_year})`
    : `AI categorization done for ${p.account_id} (${p.tax_year})`
  return result
}
