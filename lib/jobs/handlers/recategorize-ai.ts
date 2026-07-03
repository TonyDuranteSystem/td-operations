/**
 * Job Handler: recategorize_ai
 *
 * Runs the AI-assist categorization pass for an account+tax_year, AWAITED to
 * completion inside the worker.
 *
 * WHY THIS EXISTS (prod bug, 2026-06-26): `ingestPortalCsv` used to fire this
 * pass as a dangling background promise (`void recategorizeAccountYear(..,
 * {aiAssist:true})`) right before returning. On Vercel a promise that outlives
 * the HTTP response causes the serverless function to be torn down mid-flight —
 * the route then returns "No response is returned from route handler" (an empty
 * 500) to the client EVEN THOUGH the rows were already ingested. Same teardown
 * also hit the cron worker. The fix: ingestPortalCsv enqueues THIS job instead,
 * and the worker awaits it to completion — no promise ever outlives a response.
 *
 * The pass is advisory: it records ai_lean / ai_bucket hints and refines
 * categories for the still-uncategorized rows. The financials view already
 * works off the synchronous deterministic pass; these hints just land after.
 */

import type { Job, JobResult } from "../queue"

interface RecategorizeAiPayload {
  account_id: string
  tax_year: number
}

function step(name: string, status: "ok" | "error" | "skipped", detail?: string) {
  return { name, status, detail, timestamp: new Date().toISOString() }
}

export async function handleRecategorizeAi(job: Job): Promise<JobResult> {
  const p = job.payload as unknown as RecategorizeAiPayload
  const result: JobResult = { steps: [] }

  if (!p.account_id || !Number.isInteger(p.tax_year)) {
    result.steps.push(step("validate", "error", "Missing account_id or tax_year"))
    result.ok = false
    result.summary = "Invalid recategorize_ai payload"
    return result
  }

  const { recategorizeAccountYear } = await import("@/lib/tax/categorization-engine")
  const r = await recategorizeAccountYear(p.account_id, p.tax_year, { aiAssist: true })

  // Observability record (Phase 0.5) — mirror of the workspace handler.
  try {
    const { AI_MODEL, AI_PROMPT_VERSION } = await import("@/lib/tax/ai-categorizer")
    const { supabaseAdmin } = await import("@/lib/supabase-admin")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabaseAdmin as any).from("ai_categorization_runs").insert({
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
      errors: r.aiErrors,
    })
  } catch (e) {
    console.error("[recategorize-ai] run-record insert failed (job result unaffected):", e)
  }

  result.steps.push(step("ai_categorize", "ok",
    `aiCategorized=${r.aiCategorized}, recategorized=${r.recategorized}, uncategorizedRemaining=${r.uncategorizedRemaining}${r.aiErrors.length ? `, aiErrors=${r.aiErrors.length}` : ""}`))
  result.summary = `AI categorization done for ${p.account_id} (${p.tax_year})`
  return result
}
