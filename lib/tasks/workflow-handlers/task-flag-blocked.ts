/**
 * task.flag_blocked — Generic handler for "Needs Fix" / "Blocked" style actions.
 *
 * The action's catalog row declares the resulting workflow_state via
 * on_success_meta (e.g. "Needs Fix", "Blocked"); the handler's only job is
 * to capture the operator-supplied note into task_meta so it surfaces in
 * the audit trail and the UI without losing the original phrasing.
 *
 * No external side effects. No rollback path needed.
 *
 * Expected params shape:
 *   { note: string }  (action declares requires_input.field='note', required:true)
 */

import type { HandlerContext, HandlerResult, WorkflowHandler } from "@/lib/tasks/types"

/** Re-export the central client-safe schema for the workflow editor. */
export { taskFlagBlockedParams as handlerParamsSchema } from "@/lib/tasks/handler-param-schemas"

export const taskFlagBlocked: WorkflowHandler = async (ctx: HandlerContext): Promise<HandlerResult> => {
  const params = (ctx.params ?? {}) as { note?: unknown }
  const note = typeof params.note === "string" ? params.note.trim() : ""

  if (!note) {
    return {
      success: false,
      error: {
        code: "MISSING_PARAM_NOTE",
        message: "task.flag_blocked requires a non-empty 'note' parameter",
      },
      side_effects: [],
    }
  }

  if (ctx.mode === "preview") {
    return {
      success: true,
      side_effects: [],
      preview: {
        portal_message: undefined,
      },
      task_meta_patch: { last_block_note: note },
    }
  }

  return {
    success: true,
    side_effects: [
      {
        kind: "task_meta.last_block_note",
        detail: `Recorded block note (${note.length} chars)`,
      },
    ],
    task_meta_patch: {
      last_block_note: note,
      last_blocked_at: new Date().toISOString(),
    },
    result: { note_length: note.length },
  }
}
