/**
 * chain.await_client_action — Generic handler for "wait for the client to
 * do something off-platform" steps in a workflow chain.
 *
 * Pure state-change handler. The action's catalog row declares the resulting
 * workflow_state (e.g. "Awaiting client signature", "Awaiting client mailing")
 * via on_success_meta; on_success_status is typically 'Waiting'. The handler
 * optionally captures the operator's note about what specifically is being
 * awaited so it surfaces in the audit trail.
 *
 * No external side effect. No rollback.
 *
 * Expected params shape:
 *   { awaiting_note?: string }
 */

import type { HandlerContext, HandlerResult, WorkflowHandler } from "@/lib/tasks/types"

/** Re-export the central client-safe schema for the workflow editor. */
export { chainAwaitClientActionParams as handlerParamsSchema } from "@/lib/tasks/handler-param-schemas"

export const chainAwaitClientAction: WorkflowHandler = async (
  ctx: HandlerContext,
): Promise<HandlerResult> => {
  const params = (ctx.params ?? {}) as { awaiting_note?: unknown }
  const note = typeof params.awaiting_note === "string" ? params.awaiting_note.trim() : ""

  return {
    success: true,
    side_effects: [
      {
        kind: "task.awaiting_client",
        detail: note || "no note",
      },
    ],
    task_meta_patch: {
      awaiting_since: new Date().toISOString(),
      ...(note ? { awaiting_note: note } : {}),
    },
  }
}
