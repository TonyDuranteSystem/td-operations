/**
 * Pure-logic helpers for the /api/cron/workflow-sla-check cron (Slice 10).
 *
 * Extracted to a .ts module (no Next.js / no DB imports) so vitest can
 * test the decision rules without needing the route runtime. Mirrors the
 * itin-processing-reminder.ts pattern from Slice 5.1-followup.
 *
 * Rules (per the master plan SLA design):
 *   - A workflow task's SLA comes from its PINNED workflow_snapshot.sla
 *     (warn_hours, escalate_hours, escalate_to). Snapshot-pinned at task
 *     creation, so editing the catalog after spawn doesn't change the
 *     in-flight task's SLA.
 *   - If snapshot has no sla field, the task is exempt — cron skips it.
 *   - Tasks with status='Done' or 'Cancelled' are exempt (caller filters).
 *   - Age is measured from `task.created_at` to `now`. Status='Waiting' or
 *     workflow_state='Blocked' still count — SLA tracks total time-to-
 *     resolve, not active-work time, by business definition.
 *   - Idempotency: task_meta.sla_state stamps the current tier ('warn' |
 *     'escalated'). Re-running the cron on a task that's already in the
 *     same tier returns a *_no_op decision — no action taken.
 *   - Escalate beats warn: if a task is past escalate_hours and the cron
 *     hasn't escalated it yet (sla_state != 'escalated'), it's escalated
 *     directly (skipping the intermediate warn write if it never got one).
 */

export interface SlaConfig {
  warn_hours?: number
  escalate_hours?: number
  escalate_to?: string
  /** Slice 10: opt-out for the cron's default "reassign on escalate" behavior. */
  auto_reassign?: boolean
  /** Slice 10: staff inbox override; default applied at cron runtime; empty string = skip email. */
  notify_email_to?: string
}

export interface SlaCheckTask {
  id: string
  created_at: string
  /** task_meta as read from DB; may contain prior sla_state from earlier runs. */
  task_meta: Record<string, unknown> | null
}

export type SlaDecision =
  | { tier: "ok"; reason: "no_sla" | "within_warn" | "invalid_dates" }
  | { tier: "warn"; hours_waiting: number; warn_threshold: number }
  | { tier: "warn_no_op"; hours_waiting: number; warn_threshold: number }
  | {
      tier: "escalate"
      hours_waiting: number
      escalate_threshold: number
      escalate_to?: string
    }
  | {
      tier: "escalate_no_op"
      hours_waiting: number
      escalate_threshold: number
    }

const HOUR_MS = 60 * 60 * 1000

function readSlaState(taskMeta: Record<string, unknown> | null): string | null {
  if (!taskMeta) return null
  const v = taskMeta.sla_state
  return typeof v === "string" ? v : null
}

export function decideSlaTier(
  task: SlaCheckTask,
  sla: SlaConfig | null | undefined,
  now: Date,
): SlaDecision {
  // No SLA in snapshot → exempt.
  if (!sla || (sla.warn_hours == null && sla.escalate_hours == null)) {
    return { tier: "ok", reason: "no_sla" }
  }

  const createdMs = Date.parse(task.created_at)
  if (Number.isNaN(createdMs)) return { tier: "ok", reason: "invalid_dates" }
  const ageMs = now.getTime() - createdMs
  const hoursWaiting = ageMs / HOUR_MS

  const slaState = readSlaState(task.task_meta)
  const warn = typeof sla.warn_hours === "number" ? sla.warn_hours : null
  const escalate = typeof sla.escalate_hours === "number" ? sla.escalate_hours : null

  // Escalate dominates. Check it first.
  if (escalate != null && hoursWaiting >= escalate) {
    if (slaState === "escalated") {
      return { tier: "escalate_no_op", hours_waiting: hoursWaiting, escalate_threshold: escalate }
    }
    return {
      tier: "escalate",
      hours_waiting: hoursWaiting,
      escalate_threshold: escalate,
      escalate_to: sla.escalate_to,
    }
  }

  // Warn tier: past warn_hours but not yet escalate.
  if (warn != null && hoursWaiting >= warn) {
    if (slaState === "warn" || slaState === "escalated") {
      return { tier: "warn_no_op", hours_waiting: hoursWaiting, warn_threshold: warn }
    }
    return { tier: "warn", hours_waiting: hoursWaiting, warn_threshold: warn }
  }

  return { tier: "ok", reason: "within_warn" }
}
