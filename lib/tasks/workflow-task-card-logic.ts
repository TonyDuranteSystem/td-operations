/**
 * Pure-logic helpers for WorkflowTaskCard.
 *
 * Extracted into a .ts file (no JSX) so vitest in node environment can import
 * them without triggering vite's JSX parser. The actual rendering lives in
 * components/tasks/workflow-task-card.tsx which re-exports these helpers for
 * convenience.
 */

import type { CrmRole, WorkflowActionDefinition } from "./types"

/** Filter actions by the viewer's CRM role. */
export function filterActionsByRole(
  actions: WorkflowActionDefinition[],
  role: CrmRole,
): WorkflowActionDefinition[] {
  return actions.filter((a) => a.permission.role_in.includes(role))
}

/**
 * Filter actions by the current SD stage (Slice 9). Actions without
 * `visible_when.sd_stage` are always visible (backwards-compatible).
 * When `visible_when.sd_stage` is set, the action is visible only if the
 * current stage matches (single string match, or array-of-strings any-of).
 *
 * If currentSdStage is null/undefined (e.g. the workflow task doesn't have a
 * linked SD yet, or task_meta.sd_stage hasn't been seeded), actions with
 * sd_stage predicates are HIDDEN — defensive default. Actions without
 * predicates remain visible regardless.
 */
export function filterActionsByStage(
  actions: WorkflowActionDefinition[],
  currentSdStage: string | null | undefined,
): WorkflowActionDefinition[] {
  return actions.filter((a) => {
    const required = a.visible_when?.sd_stage
    if (required === undefined) return true // no predicate → always visible
    if (!currentSdStage) return false // predicate set but stage unknown → hide
    if (typeof required === "string") return required === currentSdStage
    return required.includes(currentSdStage)
  })
}

/**
 * Split a list of actions into a primary (explicit primary if present, else
 * the first) and the rest.
 */
export function splitPrimary(actions: WorkflowActionDefinition[]): {
  primary: WorkflowActionDefinition | null
  rest: WorkflowActionDefinition[]
} {
  if (actions.length === 0) return { primary: null, rest: [] }
  const explicit = actions.find((a) => a.primary === true)
  const primary = explicit ?? actions[0]
  const rest = actions.filter((a) => a !== primary)
  return { primary, rest }
}
