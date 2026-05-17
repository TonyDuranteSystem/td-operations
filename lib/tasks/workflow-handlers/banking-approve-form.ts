/**
 * banking.approve_form — Unified handler for banking review workflows.
 *
 * Single handler serving ALL banking provider variants (Payset, Relay, and
 * any future provider). Provider-specific follow-up task content lives in
 * the catalog row's handler_params.followup_task, NOT in handler code.
 *
 * The handler:
 *   1. Calls lib/operations/banking-review.ts::approveAndApplyBankingReview
 *      (shared with MCP tool banking_form_review — single idempotency point
 *       across both surfaces, B9 mitigation).
 *   2. If already applied → return early (no duplicate followup).
 *   3. Reads handler_params.followup_task from the catalog action.
 *   4. Interpolates title/description templates with task_meta values
 *      using interpolateStringStrict (missing tokens → loud failure, not
 *      literal "{token}" leaking into a task title).
 *   5. Spawns the follow-up plain task.
 *
 * Adding a new banking provider (e.g. Mercury) after this handler ships:
 *   - INSERT into task_workflows with triggered_by.filter.provider='mercury'
 *     and handler_params.followup_task carrying Mercury-specific copy.
 *   - Zero code change. Payset and Relay rows are untouched and at zero
 *     regression risk.
 *
 * task_meta MUST conform to WORKFLOW_SCHEMAS.banking_review_v1 (validated
 * by the dispatcher before this handler runs).
 *
 * handler_params MUST conform to FollowupTaskParams below. Schema-validated
 * at handler entry; malformed → clean error, no partial state.
 */

import { z } from "zod"
import { approveAndApplyBankingReview } from "@/lib/operations/banking-review"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { interpolateStringStrict } from "@/lib/template-interpolation"
import type { HandlerContext, HandlerResult, SideEffect, WorkflowHandler } from "@/lib/tasks/types"
import type { BankingReviewV1Meta } from "@/lib/tasks/workflow-schemas"

// ── handler_params shape ────────────────────────────────────────────────
//
// Provider-specific copy lives here, in CATALOG DATA. The handler reads
// it and interpolates templates against task_meta.
const FollowupTaskSpec = z.object({
  title_template: z.string().min(1),
  description_template: z.string().min(1),
  assignee: z.string().min(1),
  priority: z.enum(["Urgent", "High", "Normal", "Low"]),
  category: z.string().min(1),
})

const HandlerParamsSchema = z.object({
  followup_task: FollowupTaskSpec,
})

type HandlerParamsT = z.infer<typeof HandlerParamsSchema>

// ────────────────────────────────────────────────────────────────────────

type ReadParamsResult =
  | { ok: true; params: HandlerParamsT; error?: undefined }
  | { ok: false; params?: undefined; error: string }

function readHandlerParams(ctx: HandlerContext): ReadParamsResult {
  const raw = ctx.action.handler_params
  const parsed = HandlerParamsSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      error: `Catalog data error: action ${ctx.action.slug} for ${ctx.workflow.slug} has invalid handler_params: ${parsed.error.message}`,
    }
  }
  return { ok: true, params: parsed.data }
}

type InterpResult =
  | { ok: true; title: string; description: string; error?: undefined }
  | { ok: false; title?: undefined; description?: undefined; error: string }

function interpolateFollowup(
  spec: HandlerParamsT["followup_task"],
  meta: BankingReviewV1Meta,
): InterpResult {
  const ctx = { ...meta } as Record<string, unknown>
  const title = interpolateStringStrict(spec.title_template, ctx)
  if (!title) {
    return { ok: false, error: `title_template references token missing from task_meta: ${spec.title_template}` }
  }
  const description = interpolateStringStrict(spec.description_template, ctx)
  if (!description) {
    return { ok: false, error: `description_template references token missing from task_meta: ${spec.description_template}` }
  }
  return { ok: true, title, description }
}

export const bankingApproveForm: WorkflowHandler = async (
  ctx: HandlerContext,
): Promise<HandlerResult> => {
  const meta = ctx.task.task_meta as unknown as BankingReviewV1Meta

  const paramsRead = readHandlerParams(ctx)
  if (!paramsRead.ok) {
    return {
      success: false,
      error: { code: "HANDLER_PARAMS_INVALID", message: paramsRead.error },
      side_effects: [],
    }
  }
  const { followup_task: followup } = paramsRead.params

  if (ctx.mode === "preview") {
    const interp = interpolateFollowup(followup, meta)
    const previewTitle = interp.ok ? interp.title : `(template error) ${followup.title_template}`
    return {
      success: true,
      side_effects: [
        { kind: "submission.review.preview", detail: `Would mark submission ${meta.submission_id} reviewed` },
        { kind: "services.update.preview", detail: `Would set Banking Fintech services.status = 'Data Collected'` },
        { kind: "task.spawn.preview", detail: `Would create follow-up task: "${previewTitle}"` },
      ],
      preview: {
        portal_message: `Follow-up plain task: ${previewTitle}`,
      },
    }
  }

  // ── 1. Apply via shared helper (idempotency lives here) ────────────────
  const result = await approveAndApplyBankingReview({
    submission_id: meta.submission_id,
    actor: `workflow:banking.approve_form:${ctx.actor.id}`,
  })

  if (!result.ok) {
    return {
      success: false,
      error: {
        code: "BANKING_REVIEW_APPLY_FAILED",
        message: result.error ?? "approveAndApplyBankingReview returned ok=false",
      },
      side_effects: [],
    }
  }

  const sideEffects: SideEffect[] = []

  if (result.alreadyApplied) {
    sideEffects.push({
      kind: "submission.review.already_applied",
      detail: `Submission ${meta.submission_id} was already reviewed — skipping follow-up spawn`,
    })
    return {
      success: true,
      side_effects: sideEffects,
      task_meta_patch: { applied_at_existing: true, services_update: result.services_update },
      result: { already_applied: true, provider: result.provider },
    }
  }

  sideEffects.push({
    kind: "submission.reviewed",
    detail: `banking_submissions.reviewed_at set; services.${result.services_update}`,
    ref_id: meta.submission_id,
  })
  if (result.services_update === "error" && result.services_update_error) {
    sideEffects.push({
      kind: "services.update.error",
      detail: result.services_update_error,
    })
  }

  // ── 2. Interpolate follow-up task templates from catalog handler_params ─
  const interp = interpolateFollowup(followup, meta)
  if (!interp.ok) {
    // Helper already applied; cannot roll back. Surface as warning, return success.
    sideEffects.push({
      kind: "task.spawn.failed",
      detail: interp.error,
    })
    return {
      success: true,
      side_effects: sideEffects,
      task_meta_patch: { applied_at: new Date().toISOString(), services_update: result.services_update, followup_task_id: null },
      result: { provider: result.provider, services_update: result.services_update, followup_task_id: null, followup_skipped: true },
    }
  }

  // ── 3. Dedup-check by title+account (don't double-spawn on re-click) ──
  // .limit(1) guards against the edge case where 2+ tasks happen to share
  // the title (data inconsistency) — maybeSingle alone would error and we
  // would silently fall through and spawn a 3rd duplicate.
  const { data: existing } = await supabaseAdmin
    .from("tasks")
    .select("id")
    .eq("task_title", interp.title)
    .eq("account_id", meta.account_id)
    .limit(1)
    .maybeSingle()

  let followupTaskId: string | null = null
  if (existing) {
    sideEffects.push({
      kind: "task.spawn.skipped",
      detail: `Follow-up task already exists (id ${existing.id})`,
      ref_id: existing.id,
    })
    followupTaskId = existing.id
  } else {
    // eslint-disable-next-line no-restricted-syntax -- plain follow-up task spawn from workflow handler; createWorkflowTask in lib/operations/task is for workflow tasks only. See dev_task fda76fd3 for plain-task helper extraction.
    const { data: spawned, error: spawnErr } = await supabaseAdmin
      .from("tasks")
      .insert({
        task_title: interp.title,
        description: interp.description,
        assigned_to: followup.assignee,
        priority: followup.priority,
        category: followup.category as never,
        status: "To Do",
        account_id: meta.account_id,
        contact_id: meta.contact_id ?? null,
        created_by: "workflow:banking.approve_form",
        attachments: [],
      })
      .select("id")
      .single()
    if (spawnErr || !spawned) {
      sideEffects.push({
        kind: "task.spawn.failed",
        detail: `Failed to spawn follow-up task: ${spawnErr?.message ?? "no row returned"}`,
      })
    } else {
      followupTaskId = spawned.id
      sideEffects.push({
        kind: "task.spawned",
        detail: `Follow-up plain task created: "${interp.title}"`,
        ref_id: spawned.id,
        rollback: async () => {
          // eslint-disable-next-line no-restricted-syntax -- rollback of self-spawned plain task; cancellation is the lightest reversible action.
          await supabaseAdmin.from("tasks").update({ status: "Cancelled" }).eq("id", spawned.id)
        },
      })
    }
  }

  return {
    success: true,
    side_effects: sideEffects,
    task_meta_patch: {
      applied_at: new Date().toISOString(),
      services_update: result.services_update,
      followup_task_id: followupTaskId,
    },
    result: {
      provider: result.provider,
      services_update: result.services_update,
      followup_task_id: followupTaskId,
    },
  }
}
