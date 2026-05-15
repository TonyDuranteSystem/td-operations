/**
 * task.reassign — Generic handler for "Reassign Task" action.
 *
 * Reassigns the task to a different person. The action's catalog row
 * typically keeps the current status (e.g. on_success_status='To Do').
 *
 * The handler records the previous assignee in task_meta so the audit
 * trail surfaces who-handed-off-to-whom. The side_effect rollback reverts
 * the assignment if a downstream step in the same transaction fails.
 *
 * Expected params shape:
 *   { assigned_to: string }   non-empty, the new assignee — required
 */

import { updateTask } from "@/lib/operations/task"
import type { HandlerContext, HandlerResult, WorkflowHandler } from "@/lib/tasks/types"

export const taskReassign: WorkflowHandler = async (ctx: HandlerContext): Promise<HandlerResult> => {
  const params = (ctx.params ?? {}) as { assigned_to?: unknown }
  const newAssignee = typeof params.assigned_to === "string" ? params.assigned_to.trim() : ""

  if (!newAssignee) {
    return {
      success: false,
      error: { code: "MISSING_ASSIGNED_TO", message: "task.reassign requires non-empty 'assigned_to' parameter" },
      side_effects: [],
    }
  }

  const previousAssignee = ctx.task.assigned_to

  if (newAssignee === previousAssignee) {
    return {
      success: false,
      error: { code: "SAME_ASSIGNEE", message: `Task is already assigned to ${newAssignee}` },
      side_effects: [],
    }
  }

  if (ctx.mode === "preview") {
    return {
      success: true,
      side_effects: [],
      task_patch: { assigned_to: newAssignee },
      task_meta_patch: { previous_assignee: previousAssignee },
    }
  }

  // Rollback: revert assigned_to to its previous value if a later side-effect
  // in this transaction fails. The handler itself does NOT mutate the task —
  // the dispatcher's post-success updateTask call applies task_patch.
  // But if the dispatcher has already committed by the time a later step
  // fails, the rollback function reverts via a fresh updateTask call.
  const rollback = async () => {
    await updateTask({
      id: ctx.task.id,
      patch: { assigned_to: previousAssignee },
      actor: "workflow-dispatcher-rollback",
      summary: `Reassign rolled back to ${previousAssignee}`,
      details: { from: newAssignee, to: previousAssignee, reason: "side_effect_rollback" },
    })
  }

  return {
    success: true,
    side_effects: [
      {
        kind: "task.assignee_changed",
        detail: `${previousAssignee} → ${newAssignee}`,
        rollback,
      },
    ],
    task_patch: { assigned_to: newAssignee },
    task_meta_patch: { previous_assignee: previousAssignee, reassigned_at: new Date().toISOString() },
  }
}
