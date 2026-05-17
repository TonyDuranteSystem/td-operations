/**
 * Workflow trigger schema — declares WHEN a workflow gets spawned.
 *
 * Each `task_workflows` catalog row may carry an optional `triggered_by`
 * field in its metadata. The auto-chain dispatchers (form-completed routes
 * today; future SD-created hooks, payment hooks, etc.) consult this field
 * to find the matching workflow for an incoming event — instead of the
 * legacy pattern of hardcoding a workflow slug in route code.
 *
 * Slice 8 ships only the `form_submission` source. The discriminated union
 * is forward-compatible: adding new source types (sd_created, payment_received,
 * etc.) is a one-line addition to the union — existing rows are unaffected.
 *
 * Filter shape: exact-match on top-level fields of the submission/event row.
 * If `filter` is absent, the trigger matches ALL events of that source+table.
 * More elaborate predicates (OR, range, regex, nested paths) are intentionally
 * out of scope for Slice 8 — extend the schema when a real workflow needs it.
 *
 * Workflows WITHOUT a `triggered_by` field are NOT auto-spawned. They are
 * either spawned by `chain.spawn_next_workflow` from an upstream workflow,
 * or manually created by an admin (e.g. banking_physical_progress in Slice 8).
 */

import { z } from "zod"

// ─── Source-specific trigger shapes ──────────────────────────────────────

/**
 * Triggered when a public form (banking, tax, ITIN, ...) is submitted by a
 * client and the corresponding `/api/<service>-form-completed` route runs.
 *
 * - table: which submissions table (e.g. "banking_submissions"). The dispatcher
 *   matches this against the formTable argument from the route.
 * - filter: optional exact-match map. If present, ALL keys must match the
 *   corresponding fields on the submission row. If absent, the trigger fires
 *   for every submission to that table (single-variant services like tax).
 */
const FormSubmissionTrigger = z.object({
  source: z.literal("form_submission"),
  table: z.string().min(1),
  // Zod v4: z.record requires (keyType, valueType). Keys are catalog row field
  // names (strings). Values are primitive submission-field values.
  filter: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
})

// ─── Discriminated union (extend by adding new triggers + union members) ─

export const TriggeredBySchema = z.discriminatedUnion("source", [
  FormSubmissionTrigger,
  // Future: SdCreatedTrigger, PaymentReceivedTrigger, ManualOnlyMarker, etc.
])

export type TriggeredBy = z.infer<typeof TriggeredBySchema>
export type FormSubmissionTriggerT = z.infer<typeof FormSubmissionTrigger>

// ─── Parse / match helpers ───────────────────────────────────────────────

/**
 * Safe-parse a candidate value into a TriggeredBy. Used by the dispatcher
 * when scanning catalog rows — malformed rows return null, get logged, and
 * are SKIPPED (not crashed on). Catalog data integrity is a data error,
 * never a runtime exception.
 */
export function parseTriggeredBy(raw: unknown): TriggeredBy | null {
  if (raw === null || raw === undefined) return null
  const result = TriggeredBySchema.safeParse(raw)
  return result.success ? result.data : null
}

/**
 * Exact-match filter check. Returns true if every key in `filter` exists on
 * `event` AND equals the filter's expected value. Empty/missing filter
 * matches everything.
 *
 * Strict equality (no string-vs-number coercion). The catalog row's filter
 * values should be the same primitive type as the event field they match.
 */
export function matchesFilter(
  filter: Record<string, string | number | boolean> | undefined,
  event: Record<string, unknown>,
): boolean {
  if (!filter || Object.keys(filter).length === 0) return true
  for (const [key, expected] of Object.entries(filter)) {
    if (event[key] !== expected) return false
  }
  return true
}
