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
 * task_meta_schema field. Slice 4 adds the first entry.
 *
 * Bumping the schema name (e.g. itin_review_v1 → itin_review_v2) is the
 * versioning mechanism: existing tasks finish on v1, new tasks reference v2.
 *
 * See: sysdoc 'ops-2026-05-15-workflow-system-slice-0-audit'.
 */

import { z, type ZodTypeAny } from "zod"

// ── itin_review_v1 ─────────────────────────────────────────────────────
//
// Validates the task_meta shape produced by /api/itin-form-completed Step 6
// for the workflow_slug='itin_review' task. The dispatcher applies this
// schema in two places: at task creation (so a bad submission fails loud
// rather than silently producing a broken review task) and on every action
// (so a hand-edited task can't slip through with garbage attachments).
const ItinReviewV1 = z.object({
  submission_id: z.string().uuid(),
  drive_folder_id: z.string().min(1),
  attachments: z
    .array(
      z.object({
        kind: z.enum(["w7", "1040nr", "schedule_oi", "passport_copy"]),
        file_id: z.string().min(1),
        file_name: z.string().min(1),
        mime_type: z.literal("application/pdf"),
      }),
    )
    .min(3),
  generated_at: z.string().datetime(),
  client_language: z.enum(["en", "it"]),
  client_email: z.string().email(),
  client_first_name: z.string().min(1),
  client_last_name: z.string().min(1),
})

export type ItinReviewV1Meta = z.infer<typeof ItinReviewV1>

export const WORKFLOW_SCHEMAS: Record<string, ZodTypeAny> = {
  itin_review_v1: ItinReviewV1,
}

/** Returns the schema for a given task_meta_schema name, or null if not registered. */
export function getWorkflowSchema(schemaName: string | undefined | null): ZodTypeAny | null {
  if (!schemaName) return null
  return WORKFLOW_SCHEMAS[schemaName] ?? null
}

/** All registered schema names. Used by the exhaustiveness test. */
export function getRegisteredSchemaNames(): string[] {
  return Object.keys(WORKFLOW_SCHEMAS)
}
