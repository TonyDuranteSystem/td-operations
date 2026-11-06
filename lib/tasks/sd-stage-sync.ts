/**
 * Keep a workflow task's task_meta in sync with its service delivery's stage.
 *
 * The workspace (`/flows/[delivery_id]`) advances the SD via
 * `advanceServiceDelivery`, which is a DIFFERENT path from the workflow engine's
 * `chain.advance_sd_stage` handler. The workspace path never patched the linked
 * `formation_progress` task's `task_meta`, so the task card showed a stale
 * stage. This pure helper produces the merged task_meta to write after an
 * advance; the DB read-modify-write lives in `lib/service-delivery.ts`.
 *
 * Both `sd_stage` and `workflow_state` are set to the SD's new stage name:
 * `sd_stage` is what the card displays as the current stage, and (for the
 * workspace-pointer formation_progress card) `workflow_state` is the state label
 * shown in the card's bottom row.
 */
export function mergeSdStageIntoTaskMeta(
  meta: Record<string, unknown> | null | undefined,
  stage: string,
): Record<string, unknown> {
  return { ...(meta ?? {}), sd_stage: stage, workflow_state: stage }
}

/**
 * Which workflow card follows each service's moves: the workspace advances a job through advanceServiceDelivery, so the card's stored stage is
 * kept in step there (section 6b). Company Closure's card has buttons (not a read-only pointer), but its buttons are shown by the job's step,
 * so it must follow every move too — otherwise three open closure cards sat on "Data Collection" after the workspace moved the job
 * (bug-hunter 2026-11-05).
 */
export const POINTER_WORKFLOW_SLUG_BY_SERVICE: Record<string, string> = {
  "Company Formation": "formation_progress",
  "ITIN": "itin_review",
  "Company Closure": "closure_progress",
}
