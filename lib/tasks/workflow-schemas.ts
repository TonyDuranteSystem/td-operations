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

// ── banking_review_v1 ──────────────────────────────────────────────────
//
// Validates task_meta for the workflow tasks spawned by
// /api/banking-form-completed Step 2 when WORKFLOWS_SYSTEM is active. The
// same shape is shared by both `banking_review_payset` and
// `banking_review_relay` catalog rows — provider differentiates which one
// gets spawned (the auto-chain picks the slug based on
// banking_submissions.provider). The handler reads `submission_id` to look
// up the submission row and `provider` to compose the next-step task.
// `provider` is z.string() — NOT enum — so adding a new banking provider
// (e.g. Mercury) is a pure SQL operation: insert one task_workflows row
// with triggered_by.filter.provider = "<new>". No schema code change.
// The catalog row's triggered_by is the authoritative list of valid providers
// at runtime; this schema only enforces structural shape.
const BankingReviewV1 = z.object({
  submission_id: z.string().uuid(),
  provider: z.string().min(1),
  account_id: z.string().uuid(),
  contact_id: z.string().uuid().nullable().optional(),
  token: z.string().min(1),
  company_name: z.string().min(1),
  drive_folder_id: z.string().nullable().optional(),
})

export type BankingReviewV1Meta = z.infer<typeof BankingReviewV1>

// ── banking_physical_v1 ────────────────────────────────────────────────
//
// Validates task_meta for the manually-spawned `banking_physical_progress`
// workflow. The admin creates this task when starting a Banking Physical SD,
// setting delivery_id on the task itself so chain.advance_sd_stage can find
// the SD. account_id is required for context (chat threading, logging).
const BankingPhysicalV1 = z.object({
  account_id: z.string().uuid(),
  service_delivery_id: z.string().uuid(),
  initial_stage: z.string().min(1).optional(),
})

export type BankingPhysicalV1Meta = z.infer<typeof BankingPhysicalV1>

// ── tax_form_review_v1 ─────────────────────────────────────────────────
//
// Validates task_meta for the workflow task spawned by
// /api/tax-form-completed code-step 3. The handler reads submission_id to
// look up the submission row and call approveAndApplyTaxReview, which
// enqueues the tax_form_setup background job that does the actual CRM
// updates (contact + account + tax_returns + form review flag).
const TaxFormReviewV1 = z.object({
  submission_id: z.string().uuid(),
  account_id: z.string().uuid(),
  contact_id: z.string().uuid().nullable().optional(),
  tax_year: z.number().int().min(2000).max(2100),
  entity_type: z.string().min(1),
  token: z.string().min(1),
  company_name: z.string().min(1),
})

export type TaxFormReviewV1Meta = z.infer<typeof TaxFormReviewV1>

export const WORKFLOW_SCHEMAS: Record<string, ZodTypeAny> = {
  itin_review_v1: ItinReviewV1,
  banking_review_v1: BankingReviewV1,
  banking_physical_v1: BankingPhysicalV1,
  tax_form_review_v1: TaxFormReviewV1,
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
