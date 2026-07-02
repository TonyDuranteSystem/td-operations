/**
 * Job Handler: recategorize_workspace_ai
 *
 * The workspace twin of `recategorize_ai` — runs the AI-assist categorization
 * pass for ONE P&L workspace, AWAITED to completion inside the worker (never a
 * dangling promise — the documented Vercel teardown bug, 2026-06-26).
 *
 * Enqueued by the Generate P&L action (app/api/tools/pnl/[id]/generate) when
 * uncategorized rows remain after the deterministic passes — one pass per
 * generation, never on a partial upload set. Policy is byte-identical to the
 * client path via the shared `decideAiSuggestion`.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import type { Job, JobResult } from "../queue"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

interface RecategorizeWorkspaceAiPayload {
  workspace_id: string
}

function step(name: string, status: "ok" | "error" | "skipped", detail?: string) {
  return { name, status, detail, timestamp: new Date().toISOString() }
}

export async function handleRecategorizeWorkspaceAi(job: Job): Promise<JobResult> {
  const p = job.payload as unknown as RecategorizeWorkspaceAiPayload
  const result: JobResult = { steps: [] }

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
  })

  result.steps.push(step("ai_categorize", "ok",
    `aiCategorized=${r.aiCategorized}, labeled=${r.labeled}, uncategorizedRemaining=${r.uncategorizedRemaining}${r.aiErrors.length ? `, aiErrors=${r.aiErrors.length}` : ""}`))
  result.summary = `Workspace AI categorization done (${p.workspace_id})`
  return result
}
