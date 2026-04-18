/**
 * P3.7 — Safety controls on destructive actions.
 *
 * Shared type contract for dry-run previews and a small formatter.
 *
 * Every destructive action in the CRM / MCP must expose a dry-run preview
 * that returns a DryRunResult. The preview is shown inside
 * ConfirmDestructiveDialog before the user commits. This keeps the contract
 * identical across accounts / leads / offers / documents / invoices / MCP
 * delete tools so future sites plug in mechanically.
 *
 * Reference implementations:
 *   - app/(dashboard)/accounts/actions.ts previewStatusChange
 *   - app/api/crm/admin-actions/lead-delete-preview
 */

export type DryRunSeverity = "info" | "amber" | "red"

export interface DryRunItem {
  label: string
  severity?: DryRunSeverity
  details?: string[]
}

export interface DryRunResult {
  /**
   * Counts keyed by category. Used for the one-line summary.
   * e.g. { contracts: 2, activations: 1, portal_user: 1 }
   */
  affected: Record<string, number>

  /** Human-readable line items shown inside the dialog */
  items: DryRunItem[]

  /** Warnings shown prominently above the items list */
  warnings?: string[]

  /**
   * If present, commit is blocked regardless of user intent
   * (e.g. "3 paying members still attached — remove them first").
   */
  blocker?: string

  /** Optional label describing the target record, shown in the dialog header */
  record_label?: string
}

/**
 * Total affected rows across all categories. Used for the "N items will be
 * deleted" counter in the dialog header.
 */
export function totalAffected(r: DryRunResult): number {
  return Object.values(r.affected).reduce((a, b) => a + b, 0)
}

/**
 * Pluralize a category name naively. Callers can override by providing
 * better-named keys in affected (e.g. "offers" → already plural).
 */
export function formatAffected(affected: Record<string, number>): string {
  const parts = Object.entries(affected)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`)
  return parts.length ? parts.join(", ") : "no related records"
}
