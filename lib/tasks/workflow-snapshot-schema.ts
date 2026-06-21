/**
 * Zod schema for the WorkflowSnapshot shape stored in catalog_entries.metadata
 * (catalog_id='task_workflows') and pinned into tasks.workflow_snapshot at
 * task creation.
 *
 * The dispatcher validates an in-flight task's snapshot against this schema
 * to catch corrupt or pre-Slice-1 data; a corrupt snapshot fails the action
 * with a clear error rather than crashing the handler.
 *
 * See: lib/tasks/types.ts for the TS interface this mirrors.
 */

import { z } from "zod"

const CrmRoleSchema = z.enum(["admin", "team"])

export const WorkflowPermissionSchema = z.object({
  role_in: z.array(CrmRoleSchema),
})

const TaskStatusSchema = z.enum(["To Do", "In Progress", "Waiting", "Done", "Cancelled"])

const TaskPrioritySchema = z.enum(["Urgent", "High", "Normal", "Low"])

const InputFieldSpecSchema = z.object({
  field: z.string().min(1),
  label: z.string().optional(),
  required: z.boolean().optional(),
  optional: z.boolean().optional(),
  type: z.enum(["text", "textarea", "url", "date", "drive_url", "itin_number", "file"]).optional(),
  placeholder: z.string().optional(),
  help: z.string().optional(),
  upload_subfolder: z.string().optional(),
  accept: z.string().optional(),
})

/** Backward-compatible: either a single field spec OR `{ fields: [...] }`. */
const RequiresInputSchema = z.union([
  InputFieldSpecSchema,
  z.object({ fields: z.array(InputFieldSpecSchema).min(1) }),
])

const ConfirmSchema = z.object({
  preview_template: z.string().optional(),
  summary: z.string().optional(),
})

/**
 * Optional visibility predicate for an action button. When set, the TaskCard
 * only renders this action when the predicate matches the task's current
 * state. Slice 9 introduces this for multi-stage SD-lifecycle workflows
 * (formation_progress, closure_progress, onboarding_progress) so Luca sees
 * only the buttons relevant to the SD's current stage.
 *
 * Today the only supported predicate is `sd_stage` (matches against
 * task_meta.sd_stage, which the dispatcher seeds at spawn and the
 * chain.advance_sd_stage handler updates after each transition). Forward-
 * compatible: add new keys for new predicates (e.g. workflow_state, role,
 * task_meta_field) — actions without `visible_when` stay always-visible
 * (backwards-compatible).
 *
 * Accepted shapes for sd_stage:
 *   { sd_stage: "EIN Application" }            — single stage match
 *   { sd_stage: ["State Filing", "EIN Application"] }  — any of the listed
 */
const VisibleWhenSchema = z.object({
  sd_stage: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
})

export const WorkflowActionDefinitionSchema = z.object({
  slug: z.string().min(1),
  label_admin: z.string().min(1),
  primary: z.boolean().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  permission: WorkflowPermissionSchema,
  handler: z.string().min(1),
  handler_params: z.record(z.string(), z.unknown()).optional(),
  requires_input: RequiresInputSchema.optional(),
  confirm: ConfirmSchema.optional(),
  visible_when: VisibleWhenSchema.optional(),
  on_success_status: TaskStatusSchema,
  on_success_meta: z.record(z.string(), z.unknown()).optional(),
})

export const WorkflowSnapshotSchema = z.object({
  slug: z.string().min(1),
  version: z.number().int().positive(),
  label_admin: z.string().min(1),
  icon: z.string().optional(),
  default_assignee: z.string().optional(),
  default_priority: TaskPrioritySchema.optional(),
  permission: WorkflowPermissionSchema,
  attachment_template: z.string().optional(),
  task_meta_schema: z.string().optional(),
  auto_topic: z.string().optional(),
  // Optional task-title / description templates. When set, the dispatcher
  // interpolates `{token}` placeholders against the merged
  // (submission ∪ task_meta) context at spawn time, so callers don't have to
  // build the literal title in route code. If unset, callers' explicit
  // task_title / description still wins (backward-compatible).
  task_title_template: z.string().min(1).optional(),
  description_template: z.string().min(1).optional(),
  sla: z
    .object({
      warn_hours: z.number().positive(),
      escalate_hours: z.number().positive(),
      escalate_to: z.string().min(1),
      // Slice 10: per-workflow opt-out for the default "reassign on escalate"
      // behavior. Default true — task moves to sla.escalate_to. Set false to
      // keep the original assignee while still flagging the task as escalated.
      auto_reassign: z.boolean().optional(),
      // Slice 10: per-workflow staff inbox override for the escalation email.
      // Default "support@tonydurante.us" applied at cron runtime when
      // escalate_to is set. Set to empty string to suppress the email entirely
      // (e.g. for workflows where the reassign alone is the signal).
      notify_email_to: z.string().optional(),
    })
    .optional(),
  // When `workspace_pointer` is true, the TaskCard renders as a read-only
  // pointer to the SD's `/flows/[delivery_id]` workspace (current stage + an
  // "Open in Workspace" link) and shows NO inline action buttons — the
  // workspace is the single control surface (formation_progress, 2026-06-20).
  // Such workflows may legitimately carry an empty `actions` array; every other
  // workflow still requires ≥1 action (enforced by the refine below).
  workspace_pointer: z.boolean().optional(),
  actions: z.array(WorkflowActionDefinitionSchema),
}).superRefine((snap, ctx) => {
  if (!snap.workspace_pointer && snap.actions.length < 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["actions"],
      message: "actions must contain at least 1 action unless workspace_pointer is true",
    })
  }
})

/** Parse + validate a snapshot value from JSONB. Throws on failure. */
export function parseWorkflowSnapshot(raw: unknown) {
  return WorkflowSnapshotSchema.parse(raw)
}

/**
 * Build the JSONB blob to store in `tasks.workflow_snapshot` from a
 * `catalog_entries` row.
 *
 * Why this exists (carved-in-stone after bugfix cf0cb867): `slug` lives on
 * the catalog row's `slug` column, NOT inside its `metadata`. Every site that
 * stores a workflow_snapshot must merge slug into metadata, or TaskCard's
 * `parseWorkflowSnapshot` fails and the ErrorBoundary fires. Both dispatchers
 * + the chained-spawn path in `app/api/tasks/[id]/action/route.ts` MUST go
 * through this helper so the bug becomes structurally impossible.
 *
 * Pure, side-effect-free, does not mutate either argument.
 */
export function buildSnapshotForStorage(row: {
  slug: string
  metadata: Record<string, unknown> | null | undefined
}): Record<string, unknown> {
  return { ...(row.metadata ?? {}), slug: row.slug }
}
