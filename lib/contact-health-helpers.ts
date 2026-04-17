/**
 * P3.4 #3 — pure helpers used by components/contacts/contact-health-panel.tsx.
 *
 * Extracted to a plain .ts file so vitest's unit-test config can import
 * them without tripping on JSX in the panel component.
 */

export interface HealthCheck {
  id: string
  category: string
  label: string
  status: "ok" | "warning" | "error" | "info"
  detail: string
}

export interface HealthSummary {
  ok: number
  warning: number
  error: number
  info: number
  total: number
}

/**
 * Add two summary objects component-wise. Missing sides are treated as
 * all-zero. Used to fold the diagnose-contact + audit-chain summaries
 * into a single "Health Summary" strip.
 */
export function combineSummaries(
  a?: HealthSummary,
  b?: HealthSummary,
): HealthSummary {
  return {
    ok: (a?.ok ?? 0) + (b?.ok ?? 0),
    warning: (a?.warning ?? 0) + (b?.warning ?? 0),
    error: (a?.error ?? 0) + (b?.error ?? 0),
    info: (a?.info ?? 0) + (b?.info ?? 0),
    total: (a?.total ?? 0) + (b?.total ?? 0),
  }
}

/**
 * Worst-status-wins rollup for a list of checks. Priority:
 *   error > warning > info > ok. Empty list returns 'empty'.
 * Used to colour a section header by its contents.
 */
export function rollupStatus(
  checks: HealthCheck[],
): "ok" | "warning" | "error" | "info" | "empty" {
  if (checks.length === 0) return "empty"
  if (checks.some(c => c.status === "error")) return "error"
  if (checks.some(c => c.status === "warning")) return "warning"
  if (checks.some(c => c.status === "info")) return "info"
  return "ok"
}
