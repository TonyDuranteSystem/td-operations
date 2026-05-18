/**
 * task.snooze — Generic handler for "Snooze until X" action.
 *
 * Sets the task's due_date to the requested future date and stamps
 * task_meta.snooze_until for filtering. The action's catalog row typically
 * declares on_success_status='Waiting'.
 *
 * Expected params shape:
 *   { until_date: string }   ISO date (YYYY-MM-DD) — required, must be in the future
 */

import type { HandlerContext, HandlerResult, WorkflowHandler } from "@/lib/tasks/types"

/** Re-export the central client-safe schema for the workflow editor. */
export { taskSnoozeParams as handlerParamsSchema } from "@/lib/tasks/handler-param-schemas"

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export const taskSnooze: WorkflowHandler = async (ctx: HandlerContext): Promise<HandlerResult> => {
  const params = (ctx.params ?? {}) as { until_date?: unknown }
  const untilDate = typeof params.until_date === "string" ? params.until_date.trim() : ""

  if (!ISO_DATE_RE.test(untilDate)) {
    return {
      success: false,
      error: {
        code: "INVALID_UNTIL_DATE",
        message: "task.snooze requires 'until_date' as ISO date (YYYY-MM-DD)",
      },
      side_effects: [],
    }
  }

  const parsed = Date.parse(`${untilDate}T00:00:00Z`)
  if (Number.isNaN(parsed)) {
    return {
      success: false,
      error: { code: "INVALID_UNTIL_DATE", message: `Cannot parse until_date '${untilDate}'` },
      side_effects: [],
    }
  }

  const todayUtc = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").getTime()
  if (parsed <= todayUtc) {
    return {
      success: false,
      error: { code: "UNTIL_DATE_NOT_FUTURE", message: `until_date '${untilDate}' must be in the future` },
      side_effects: [],
    }
  }

  if (ctx.mode === "preview") {
    return {
      success: true,
      side_effects: [],
      task_patch: { due_date: untilDate },
      task_meta_patch: { snooze_until: untilDate },
    }
  }

  return {
    success: true,
    side_effects: [
      {
        kind: "task.due_date_advanced",
        detail: `Snoozed until ${untilDate} (was ${ctx.task.due_date ?? "no due date"})`,
      },
    ],
    task_patch: { due_date: untilDate },
    task_meta_patch: { snooze_until: untilDate, snoozed_at: new Date().toISOString() },
  }
}
