/**
 * Per-workflow Zod schemas for tasks.task_meta validation.
 *
 * The dispatcher validates a task's task_meta against the schema named in
 * its workflow_snapshot.task_meta_schema before executing any handler.
 * This guards against an auto-chain inserting malformed task_meta (e.g.,
 * missing submission_id, wrong attachment shape).
 *
 * Schemas register here keyed by a stable schema-name string (e.g.
 * 'itin_review_v1'). Catalog rows reference the schema by name in their
 * task_meta_schema field. Slice 1 ships this map empty — Slice 4 lands
 * the first entry (itin_review_v1).
 *
 * Bumping the schema name (e.g. itin_review_v1 → itin_review_v2) is the
 * versioning mechanism: existing tasks finish on v1, new tasks reference v2.
 *
 * See: sysdoc 'ops-2026-05-15-workflow-system-slice-0-audit'.
 */

import type { ZodTypeAny } from "zod"

/**
 * Schema map. Slice 1 starts empty.
 *
 * Slice 4 adds:
 *   itin_review_v1: z.object({ submission_id: z.string().uuid(), ... })
 *
 * Slice 8/9 add the remaining workflows.
 */
export const WORKFLOW_SCHEMAS: Record<string, ZodTypeAny> = {}

/** Returns the schema for a given task_meta_schema name, or null if not registered. */
export function getWorkflowSchema(schemaName: string | undefined | null): ZodTypeAny | null {
  if (!schemaName) return null
  return WORKFLOW_SCHEMAS[schemaName] ?? null
}

/** All registered schema names. Used by the exhaustiveness test. */
export function getRegisteredSchemaNames(): string[] {
  return Object.keys(WORKFLOW_SCHEMAS)
}
