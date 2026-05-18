/**
 * chain.spawn_next_workflow — Generic handler that asks the dispatcher to
 * create the next workflow task in the chain.
 *
 * At Slice 2 the handler takes the slug + task_meta directly from params
 * (or from action.handler_params) and passes them through to the dispatcher
 * via HandlerResult.spawn_task. Slice 5 will introduce a service-catalog
 * `workflow_chain.transitions` lookup so the next slug is resolved from
 * the parent service's chain config instead of being supplied by the caller.
 *
 * Expected params shape (or fallback to action.handler_params):
 *   {
 *     workflow_slug: string,           // required
 *     task_meta?: Record<string, unknown>,
 *     assigned_to?: string,
 *   }
 *
 * No side effects fire from within this handler. The dispatcher creates the
 * spawned task in the success path; the audit log records the spawned task id.
 */

import type { HandlerContext, HandlerResult, WorkflowHandler } from "@/lib/tasks/types"

/** Re-export the central client-safe schema for the workflow editor. */
export { chainSpawnNextWorkflowParams as handlerParamsSchema } from "@/lib/tasks/handler-param-schemas"

export const chainSpawnNextWorkflow: WorkflowHandler = async (
  ctx: HandlerContext,
): Promise<HandlerResult> => {
  // Prefer explicit params; fall back to catalog action.handler_params.
  const params = (ctx.params ?? {}) as {
    workflow_slug?: unknown
    task_meta?: unknown
    assigned_to?: unknown
  }
  const handlerParams = (ctx.action.handler_params ?? {}) as {
    workflow_slug?: unknown
    task_meta?: unknown
    assigned_to?: unknown
  }

  const slug =
    typeof params.workflow_slug === "string"
      ? params.workflow_slug
      : typeof handlerParams.workflow_slug === "string"
        ? handlerParams.workflow_slug
        : ""

  // Slice 5: when no slug is provided, return success without spawn_task so
  // the dispatcher's catalog-transition resolver can take over. This is the
  // "signal: consult workflow_chain.transitions for the next step" use case
  // — most Slice 5 ITIN-chain actions use this path. When a slug IS provided
  // (legacy / explicit caller), spawn directly as before.
  if (!slug) {
    return {
      success: true,
      side_effects: [
        {
          kind: "workflow.transition_signaled",
          detail: "No explicit workflow_slug — dispatcher consults catalog transitions",
        },
      ],
    }
  }

  const taskMeta =
    (typeof params.task_meta === "object" && params.task_meta !== null
      ? (params.task_meta as Record<string, unknown>)
      : null) ??
    (typeof handlerParams.task_meta === "object" && handlerParams.task_meta !== null
      ? (handlerParams.task_meta as Record<string, unknown>)
      : {})

  const assignedTo =
    typeof params.assigned_to === "string"
      ? params.assigned_to
      : typeof handlerParams.assigned_to === "string"
        ? handlerParams.assigned_to
        : undefined

  return {
    success: true,
    side_effects: [
      {
        kind: "workflow.spawn_requested",
        detail: `Spawn ${slug}${assignedTo ? ` → ${assignedTo}` : ""}`,
      },
    ],
    spawn_task: {
      workflow_slug: slug,
      task_meta: taskMeta,
      ...(assignedTo ? { assigned_to: assignedTo } : {}),
    },
    transition: slug,
  }
}
