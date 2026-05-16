/**
 * Service catalog → workflow chain transition resolver.
 *
 * The architectural payoff of the Workflow System: after any successful
 * action, the dispatcher consults this resolver to decide what happens
 * next — purely from data in `services.metadata.workflow_chain.transitions`.
 *
 *   transitions:
 *     <current_workflow_slug>:
 *       <action_slug_or_handler_transition_key>:
 *         spawn_workflow?: string       # spawn a downstream workflow task
 *         advance_sd_stage?: string     # advance the SD to a target stage
 *
 * The resolver returns the resolved next-step OR null if nothing matches.
 * The dispatcher fires the next step on top of whatever the handler's own
 * spawn_task / side_effects did. Handler-set spawn_task takes precedence
 * over catalog spawn_workflow (the handler is the more-specific caller).
 *
 * Adding a new service's chain = catalog edit. Adding a new transition to
 * an existing service = catalog edit. No code change.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { getEntryByServiceType } from "@/lib/services"
import type { TaskRow } from "@/lib/tasks/types"

export interface ResolvedTransition {
  /** Next workflow_slug to spawn (null if no spawn). */
  spawn_workflow: string | null
  /** Target SD stage to advance to (null if no advance). */
  advance_sd_stage: string | null
}

/**
 * Resolve the catalog transition for a (task, action_slug) pair.
 *
 * Returns null if:
 *   - The task has no delivery_id (can't find the service)
 *   - The service_type doesn't map to a services catalog row
 *   - The catalog row has no workflow_chain.transitions
 *   - The transition key isn't present
 *
 * The caller (dispatcher) honors handler `spawn_task` over `spawn_workflow`,
 * and only fires the resolved transition when the handler didn't already.
 */
export async function resolveCatalogTransition(args: {
  task: TaskRow
  workflowSlug: string
  /** Use `action.slug` unless the handler explicitly returned a `transition` override. */
  transitionKey: string
}): Promise<ResolvedTransition | null> {
  const { task, workflowSlug, transitionKey } = args

  if (!task.delivery_id) return null

  // Get the service_type for the parent task's SD.
  const { data: sd } = await supabaseAdmin
    .from("service_deliveries")
    .select("service_type")
    .eq("id", task.delivery_id)
    .maybeSingle()
  if (!sd?.service_type) return null

  // Look up the services catalog row (handles the case mapping ITIN → 'itin').
  const serviceRow = await getEntryByServiceType(sd.service_type)
  if (!serviceRow) return null

  const meta = serviceRow.metadata as Record<string, unknown> | null | undefined
  const chain = meta && typeof meta === "object" ? (meta.workflow_chain as Record<string, unknown> | undefined) : undefined
  const transitions =
    chain && typeof chain === "object" ? (chain.transitions as Record<string, unknown> | undefined) : undefined
  if (!transitions || typeof transitions !== "object") return null

  const forWorkflow = transitions[workflowSlug] as Record<string, unknown> | undefined
  if (!forWorkflow || typeof forWorkflow !== "object") return null

  const resolved = forWorkflow[transitionKey] as Record<string, unknown> | undefined
  if (!resolved || typeof resolved !== "object") return null

  const spawn = typeof resolved.spawn_workflow === "string" ? resolved.spawn_workflow : null
  const advance = typeof resolved.advance_sd_stage === "string" ? resolved.advance_sd_stage : null

  if (!spawn && !advance) return null
  return { spawn_workflow: spawn, advance_sd_stage: advance }
}

/**
 * Look up a workflow catalog row to pin as the snapshot on a newly-spawned
 * task. Returns null if the row doesn't exist. The dispatcher uses this
 * after resolveCatalogTransition returns spawn_workflow.
 */
export async function getWorkflowCatalogRow(slug: string): Promise<Record<string, unknown> | null> {
  const { data } = await supabaseAdmin
    .from("catalog_entries")
    .select("metadata")
    .eq("catalog_id", "task_workflows")
    .eq("slug", slug)
    .maybeSingle()
  if (!data) return null
  const meta = data.metadata as Record<string, unknown> | null | undefined
  if (!meta || typeof meta !== "object") return null
  // Pin the slug into the snapshot so parseWorkflowSnapshot accepts it.
  return { ...meta, slug }
}
