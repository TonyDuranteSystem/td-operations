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

  result.steps.push(step("ai_categorize", "ok",
    `aiCategorized=${r.aiCategorized}, recategorized=${r.recategorized}, uncategorizedRemaining=${r.uncategorizedRemaining}${r.aiErrors.length ? `, aiErrors=${r.aiErrors.length}` : ""}`))
  result.summary = `AI categorization done for ${p.account_id} (${p.tax_year})`
  return result
}
