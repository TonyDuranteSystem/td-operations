/**
 * Job Handler: recategorize_workspace_ai (Phase 3R — chained chunks).
 *
 * One invocation = ONE CHUNK: processes batches until the runner's deadline,
 * persists per batch (Phase 0.3), then hands the baton to a continuation job
 * it inserts BEFORE returning (review cond. 2 — the runner still owns
 * completeJob; a handler that dies after the insert leaves its own row to the
 * reaper and the guard blocks duplicates).
 *
 * Chain rules (dual-review conditions):
 *  - continuation ONLY on deadline-stop WITH progress (decideChunkFollowup);
 *    kill-switch / dead-API / zero-progress chunks END the chain with
 *    result.ok=false → status='failed' → Exception Center + the watchdog's
 *    backoff ladder owns retries. The chain never spins.
 *  - pending-guard excludes SELF (.neq id) — verbatim reuse deadlocks.
 *  - chunk_index + auto_retry ride in the payload (no DDL); progress resets
 *    auto_retry to 0.
 *  - per-chunk run record written BEFORE the continuation insert.
 *  - NO triggerWorker from here (documented teardown bug) — the worker's own
 *    drain loop claims the continuation; the 5-min cron is the floor.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import type { Job, JobResult } from "../queue"
import type { JobRunContext } from "../registry"
import { AI_CHAIN_CHUNK_CAP, AI_CHAIN_JOB_PRIORITY, decideChunkFollowup } from "../chain-state"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

interface RecategorizeWorkspaceAiPayload {
  workspace_id: string
  chunk_index?: number
  auto_retry?: number
}

function step(name: string, status: "ok" | "error" | "skipped", detail?: string) {
  return { name, status, detail, timestamp: new Date().toISOString() }
}

export async function handleRecategorizeWorkspaceAi(job: Job, ctx?: JobRunContext): Promise<JobResult> {
  const p = job.payload as unknown as RecategorizeWorkspaceAiPayload
  const result: JobResult = { steps: [] }
  const chunkIndex = p.chunk_index ?? 0

  if (!p.workspace_id) {
    result.steps.push(step("validate", "error", "Missing workspace_id"))
    result.ok = false
    result.summary = "Invalid recategorize_workspace_ai payload"
    return result
  }

  // Resolve workspace context at RUN time (fresh roster; a deleted workspace
  // won't come back on retry — surface, don't throw).
  const { data: ws } = await db
    .from("pnl_workspaces")
    .select("company_name")
    .eq("id", p.workspace_id)
    .maybeSingle()
  if (!ws) {
    result.steps.push(step("resolve_workspace", "error", `workspace ${p.workspace_id} not found`))
    result.ok = false
    result.summary = "Workspace not found"
    return result
  }
  const { data: memberRows } = await db
    .from("pnl_workspace_members")
    .select("display_name")
    .eq("workspace_id", p.workspace_id)
  const memberNames = ((memberRows ?? []) as Array<{ display_name: string | null }>)
    .map(m => (m.display_name ?? "").trim())
    .filter(n => n.length > 0)

  const { recategorizeWorkspaceAi } = await import("@/lib/tax/workspace-recategorize")
  const r = await recategorizeWorkspaceAi(p.workspace_id, {
    companyName: (ws.company_name as string | null) ?? "",
    memberNames,
    aiOptions: ctx?.deadlineAt ? { deadlineAt: ctx.deadlineAt } : undefined,
  })

  const progressed = r.aiCategorized + r.labeled > 0
  const followup = decideChunkFollowup({
    stoppedOnDeadline: r.stats.stoppedOnDeadline === true,
    batchesSent: r.stats.batchesSent,
    batchesFailed: r.stats.batchesFailed,
    progressed,
    chunkIndex,
  })

  // Per-chunk observability record — written BEFORE the continuation insert
  // (cond. 8) and for FAILED chunks too; never fails the job.
  try {
    const { AI_MODEL, AI_PROMPT_VERSION } = await import("@/lib/tax/ai-categorizer")
    await db.from("ai_categorization_runs").insert({
      workspace_id: p.workspace_id,
      model: AI_MODEL,
      prompt_version: AI_PROMPT_VERSION,
      batches_sent: r.stats.batchesSent,
      batches_failed: r.stats.batchesFailed,
      truncated_batches: r.stats.truncatedBatches,
      suggestions_parsed: r.stats.suggestionsParsed,
      applied: r.aiCategorized,
      labeled: r.labeled,
      uncategorized_remaining: r.uncategorizedRemaining,
      capped: r.stats.capped,
      errors: [...r.aiErrors, `chunk=${chunkIndex}`, `followup=${followup}`],
    })
  } catch (e) {
    console.error("[recategorize-workspace-ai] run-record insert failed (job result unaffected):", e)
  }

  if (followup === "continue") {
    // Baton pass: insert the continuation BEFORE returning. Guard excludes
    // THIS job (still 'processing' until the runner completes it).
    try {
      const { data: live } = await db
        .from("job_queue")
        .select("id")
        .eq("job_type", "recategorize_workspace_ai")
        .eq("related_entity_id", p.workspace_id)
        .in("status", ["pending", "processing"])
        .neq("id", job.id)
        .limit(1)
      if (!live || live.length === 0) {
        // Zero-batch (late-claim) chunks don't consume cap fuel: the index
        // only advances when actual work happened.
        const nextChunkIndex = r.stats.batchesSent > 0 ? chunkIndex + 1 : chunkIndex
        const { error } = await db.from("job_queue").insert({
          job_type: "recategorize_workspace_ai",
          payload: { workspace_id: p.workspace_id, chunk_index: nextChunkIndex, auto_retry: 0 },
          priority: AI_CHAIN_JOB_PRIORITY,
          related_entity_type: "pnl_workspace",
          related_entity_id: p.workspace_id,
          created_by: "chain",
        })
        if (error) throw new Error(error.message)
        result.steps.push(step("chain_continuation", "ok", `chunk ${nextChunkIndex} enqueued${r.stats.batchesSent === 0 ? " (late claim — no work attempted, baton passed)" : ""}`))
      } else {
        result.steps.push(step("chain_continuation", "skipped", "another chain job already live"))
      }
    } catch (e) {
      // The watchdog revives a dropped baton on its next tick — log, don't fail.
      console.error("[recategorize-workspace-ai] continuation insert failed (watchdog will revive):", e)
      result.steps.push(step("chain_continuation", "error", e instanceof Error ? e.message : String(e)))
    }
  }

  result.steps.push(step("ai_categorize", followup === "halt_no_progress" ? "error" : "ok",
    `chunk=${chunkIndex}, followup=${followup}, aiCategorized=${r.aiCategorized}, labeled=${r.labeled}, uncategorizedRemaining=${r.uncategorizedRemaining}${r.aiErrors.length ? `, aiErrors=${r.aiErrors.length}` : ""}`))

  if (followup === "halt_no_progress") {
    // Circuit breaker: zero-progress chunk → failed job (Exception Center);
    // the watchdog's backoff ladder owns the retry, with escalation after it.
    result.ok = false
    result.summary = `Workspace AI chunk made no progress (${r.stats.batchesSent} batches, ${r.stats.batchesFailed} failed) — chain halted (${p.workspace_id})`
    return result
  }
  if (followup === "halt_cap") {
    result.ok = false
    result.summary = `Workspace AI chain hit the ${AI_CHAIN_CHUNK_CAP}-chunk cap with work remaining (${p.workspace_id})`
    return result
  }
  result.summary = followup === "continue"
    ? `Workspace AI chunk ${chunkIndex} done — continuing (${p.workspace_id})`
    : `Workspace AI categorization done (${p.workspace_id})`
  return result
}
