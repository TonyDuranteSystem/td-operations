/**
 * Pure, client-safe helpers for `pipeline_stages.auto_actions`.
 *
 * `auto_actions` is a jsonb ARRAY of per-stage action markers (mirrors
 * `auto_tasks`). Each entry is an object with a `type`. Keeping these helpers
 * dependency-free means both the server resolver (lib/services/stages.ts) and
 * the /config client dialog can share them without bundling supabase-admin.
 */

export interface StageAction {
  type: string
  [key: string]: unknown
}

/** The auto_actions marker `type` for the 2nd-installment advance target. */
export const SECOND_INSTALLMENT_TARGET_ACTION = "second_installment_target"

/** True if an auto_actions value contains an action of the given type. */
export function stageHasAction(autoActions: unknown, type: string): boolean {
  return Array.isArray(autoActions) && autoActions.some(
    a => a != null && typeof a === "object" && (a as { type?: unknown }).type === type,
  )
}

/**
 * Return a NEW auto_actions array with the given marker present or absent,
 * preserving every other action entry.
 */
export function setStageAction(autoActions: unknown, type: string, present: boolean): StageAction[] {
  const arr: StageAction[] = Array.isArray(autoActions)
    ? (autoActions.filter(a => a != null && typeof a === "object") as StageAction[])
    : []
  const without = arr.filter(a => a.type !== type)
  return present ? [...without, { type }] : without
}
