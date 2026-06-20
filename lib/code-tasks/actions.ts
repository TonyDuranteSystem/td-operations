/**
 * Pure decision logic for CRM Code Tasks actions (Approve/ship, Retry, Cancel,
 * Dismiss). Kept side-effect-free so it's unit-tested without a DB; the API route
 * (app/api/code-tasks/[id]/action/route.ts) maps each decision `kind` to the
 * actual agent_messages mutation.
 *
 * Semantics mirror the existing worker behavior:
 *  - promote → queue a new code_runner row with context_json.promote_branch
 *    (identical to the Slack "ship it" path) → runner runs promoteBranchToMain.
 *  - retry   → re-queue the SAME row (status back to 'pending').
 *  - cancel  → only meaningful for a not-yet-claimed 'pending' task (the runner
 *    claims only 'pending'); a live 'processing' session is stopped gracefully via
 *    the viewer's End Session (code_task_inputs END sentinel), not a hard kill.
 *  - dismiss → cosmetic: hide a finished/failed task from the active list.
 */

export type CodeTaskAction = "promote" | "retry" | "cancel" | "dismiss"

export interface CodeTaskActionInput {
  status: string
  code_branch: string | null
  is_promote?: boolean
}

export type CodeTaskActionDecision =
  | { ok: true; kind: "queue_promote"; branch: string }
  | { ok: true; kind: "requeue" }
  | { ok: true; kind: "mark_cancelled" }
  | { ok: true; kind: "mark_dismissed" }
  | { ok: false; error: string; code: number }

export function decideCodeTaskAction(
  task: CodeTaskActionInput,
  action: CodeTaskAction,
): CodeTaskActionDecision {
  switch (action) {
    case "promote": {
      if (task.is_promote) {
        return { ok: false, error: "This is already a promotion task.", code: 409 }
      }
      if (!task.code_branch) {
        return { ok: false, error: "This task has no review branch to ship.", code: 409 }
      }
      if (task.status !== "done") {
        return { ok: false, error: "Only a finished task with a review branch can be shipped.", code: 409 }
      }
      return { ok: true, kind: "queue_promote", branch: task.code_branch }
    }
    case "retry": {
      if (task.status !== "failed" && task.status !== "cancelled") {
        return { ok: false, error: "Only a failed or cancelled task can be retried.", code: 409 }
      }
      return { ok: true, kind: "requeue" }
    }
    case "cancel": {
      if (task.status === "pending") return { ok: true, kind: "mark_cancelled" }
      if (task.status === "processing") {
        return {
          ok: false,
          error: "This session is live — use End Session in the viewer to stop it gracefully.",
          code: 409,
        }
      }
      return { ok: false, error: "This task is not running.", code: 409 }
    }
    case "dismiss": {
      if (task.status === "processing" || task.status === "pending") {
        return { ok: false, error: "Can't dismiss a task that is still active.", code: 409 }
      }
      return { ok: true, kind: "mark_dismissed" }
    }
    default:
      return { ok: false, error: "Unknown action.", code: 400 }
  }
}
