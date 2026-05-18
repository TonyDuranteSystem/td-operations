/**
 * task.cancel — Generic handler for "Cancel Task" action.
 *
 * The action's catalog row typically declares on_success_status='Cancelled'.
 * The handler is intentionally trivial — no external side effects, no params
 * required. An optional reason can be supplied to surface in task_meta.
 *
 * Expected params shape:
 *   { reason?: string }
 */

import type { HandlerContext, HandlerResult, WorkflowHandler } from "@/lib/tasks/types"

/** Re-export the central client-safe schema for the workflow editor. */
export { taskCancelParams as handlerParamsSchema } from "@/lib/tasks/handler-param-schemas"

export const taskCancel: WorkflowHandler = async (ctx: HandlerContext): Promise<HandlerResult> => {
  const params = (ctx.params ?? {}) as { reason?: unknown }
  const reason = typeof params.reason === "string" ? params.reason.trim() : ""

  if (ctx.mode === "preview") {
    return {
      success: true,
      side_effects: [],
    }
  }

  return {
    success: true,
    side_effects: [
      {
        kind: "task.cancelled",
        detail: reason || "no reason given",
      },
    ],
    task_meta_patch: reason
      ? { cancellation_reason: reason, cancelled_at: new Date().toISOString() }
      : { cancelled_at: new Date().toISOString() },
  }
}
