/**
 * The "done" step of a service (N1a F1, dev job be7da01a, plan v8 approved 2026-10-02).
 *
 * Which step closes a job used to be decided by the step's NAME, in two copies of the same rule: a job became
 * completed when it reached a step named "Completed" or "TR Filed" (or "Closed" for the two renewal services).
 * "Mark complete" separately jumped to the highest-numbered step, which for a tax return is "Terminated - Non
 * Payment" — the wrong place.
 *
 * Now each step carries `pipeline_stages.completes_service` (migration 20261003-0100-done-step.sql), seeded to
 * reproduce today's name rule exactly. Every place that decides "does this move close the job?" asks
 * `stageCompletesService`, and "Mark complete" goes to `pickDoneStep`.
 *
 * Until that migration runs, rows carry no `completes_service` field and both helpers fall back to the legacy name
 * rule — so the code is safe to deploy before or after the database change.
 */

export interface StageLike {
  stage_name: string
  stage_order: number
  completes_service?: boolean | null
}

const RENEWAL_SERVICE_TYPES = new Set(["State RA Renewal", "State Annual Report"])

/** Today's (pre-F1) rule, kept as the fallback and as the seed the migration reproduces. */
export function legacyStageCompletesService(stageName: string, serviceType: string | null | undefined): boolean {
  if (stageName === "Completed" || stageName === "TR Filed") return true
  return stageName === "Closed" && !!serviceType && RENEWAL_SERVICE_TYPES.has(serviceType)
}

/** Does moving a job onto this step close it? */
export function stageCompletesService(stage: StageLike, serviceType: string | null | undefined): boolean {
  if (typeof stage.completes_service === "boolean") return stage.completes_service
  return legacyStageCompletesService(stage.stage_name, serviceType)
}

/**
 * The step "Mark complete" should move a job to: the service's marked done step (the highest-numbered one if several
 * are marked). Null when the service has no done step — it is then closed by its own action (ITIN finalize, the
 * formation EIN step…) and "Mark complete" must refuse rather than jump to the last step.
 *
 * Before the migration (no row carries the field) this keeps the old behaviour: the highest-numbered step.
 */
export function pickDoneStep<T extends StageLike>(stages: T[]): T | null {
  if (stages.length === 0) return null
  const sorted = [...stages].sort((a, b) => b.stage_order - a.stage_order)
  const migrated = stages.some(s => typeof s.completes_service === "boolean")
  if (!migrated) return sorted[0]
  return sorted.find(s => s.completes_service === true) ?? null
}

export const NO_DONE_STEP_MESSAGE =
  "This service has no \"done\" step, so it can't be marked complete from here — it is closed by its own action in the workspace."
