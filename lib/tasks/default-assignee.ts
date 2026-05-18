/**
 * Single source of truth for the team's default task assignee.
 *
 * Read from `process.env.DEFAULT_TASK_ASSIGNEE`, falling back to "Luca" so
 * existing deployments without the env var behave exactly as before. Every
 * site that used to literal-string "Luca" goes through this helper so
 * rotating the default assignee (Luca → Marco, vacation coverage, etc.) is
 * a single Vercel env-var update and not a 9-file grep-replace.
 *
 * Workflow tasks ALREADY honor per-workflow `default_assignee` from the
 * catalog row metadata — this helper is only the final fallback when neither
 * the caller nor the catalog row supplies an assignee. It also covers the
 * legacy plain-task fallback paths in the form-completed routes (banking,
 * tax, ITIN) which fire when workflow dispatch fails.
 *
 * Not catalog-driven (yet) on purpose: today there is one default ops owner.
 * If/when the team grows to per-functional defaults (e.g. accounting tasks
 * default to Antonio, ops to Luca), promote this to a `org_settings` catalog
 * row keyed by category. Tracked as a documented future improvement in the
 * workflows-system-slices-8-10-final-state sysdoc cookbook.
 */

export function defaultTaskAssignee(): string {
  const fromEnv = process.env.DEFAULT_TASK_ASSIGNEE
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim()
  return "Luca"
}
