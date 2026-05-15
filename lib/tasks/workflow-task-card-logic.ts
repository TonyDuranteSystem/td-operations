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
