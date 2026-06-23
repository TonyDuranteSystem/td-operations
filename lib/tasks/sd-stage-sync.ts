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
