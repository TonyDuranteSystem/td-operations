/**
 * closure.approve_data — First action of closure_progress workflow.
 *
 * Slice 9. Combines two side effects (helper apply + SD stage advance) so
 * Luca's one click both records the review AND moves the SD forward.
 *
 *  1. Locate the most recent completed-but-unreviewed closure_submission
 *     for the SD's account_id (or contact_id if pre-account closure).
 *  2. Call lib/operations/closure-review.ts::approveAndApplyClosureReview
 *     (saves to Drive + marks reviewed_at) — shared with the MCP tool.
 *  3. Advance the SD stage Data Collection → State Compliance Check using
 *     the existing advanceStage helper. task_meta.sd_stage is updated so
 *     the TaskCard's visibility_predicate filter shows the next stage's
 *     button after success.
 *
 * Idempotent: helper's reviewed_at short-circuit + advanceStage's stage
 * gate prevent double-application on re-click.
 */

import { approveAndApplyClosureReview } from "@/lib/operations/closure-review"
import { advanceStage } from "@/lib/operations/service-delivery"
import { supabaseAdmin } from "@/lib/supabase-admin"
import type { HandlerContext, HandlerResult, SideEffect, WorkflowHandler } from "@/lib/tasks/types"

/** Re-export the central client-safe schema for the workflow editor. */
export { closureApproveDataParams as handlerParamsSchema } from "@/lib/tasks/handler-param-schemas"

const TARGET_STAGE = "State Compliance Check"

export const closureApproveData: WorkflowHandler = async (
  ctx: HandlerContext,
): Promise<HandlerResult> => {
  if (!ctx.task.delivery_id) {
    return {
      success: false,
      error: {
        code: "NO_DELIVERY",
        message: "closure.approve_data requires the task to have delivery_id (linked Company Closure SD)",
      },
      side_effects: [],
    }
  }

  // ── Locate the matching submission ─────────────────────────────────
  // SD has account_id OR contact_id; submission has both. Match by whichever
  // we have, plus status='completed' (helper short-circuits if already
  // reviewed, so reviewed-status rows here are OK — they'll alreadyApplied).
  let submissionQuery = supabaseAdmin
    .from("closure_submissions")
    .select("id, account_id, contact_id, lead_id, status, completed_at")
    .in("status", ["completed", "reviewed"])
    .order("completed_at", { ascending: false })
    .limit(1)
  if (ctx.task.account_id) {
    submissionQuery = submissionQuery.eq("account_id", ctx.task.account_id)
  } else if (ctx.task.contact_id) {
    submissionQuery = submissionQuery.eq("contact_id", ctx.task.contact_id)
  } else {
    return {
      success: false,
      error: {
        code: "NO_SUBJECT",
        message: "closure.approve_data requires the task to have account_id or contact_id",
      },
      side_effects: [],
    }
  }
  const { data: submission, error: subErr } = await submissionQuery.maybeSingle()
  if (subErr) {
    return {
      success: false,
      error: { code: "SUBMISSION_LOOKUP_FAILED", message: subErr.message },
      side_effects: [],
    }
  }
  if (!submission) {
    return {
      success: false,
      error: {
        code: "SUBMISSION_NOT_FOUND",
        message: "No completed closure_submissions found for this account/contact. Client must complete the closure wizard first.",
      },
      side_effects: [],
    }
  }

  if (ctx.mode === "preview") {
    return {
      success: true,
      side_effects: [
        { kind: "submission.review.preview", detail: `Would mark submission ${submission.id} reviewed + save Drive` },
        { kind: "sd.advance.preview", detail: `Would advance SD ${ctx.task.delivery_id}: Data Collection → ${TARGET_STAGE}` },
      ],
      preview: { sd_stage_change: `Data Collection → ${TARGET_STAGE}` },
    }
  }

  // ── 1. Helper apply (Drive save + reviewed_at) ─────────────────────
  const apply = await approveAndApplyClosureReview({
    submission_id: submission.id,
    actor: `workflow:closure.approve_data:${ctx.actor.id}`,
  })
  if (!apply.ok) {
    return {
      success: false,
      error: { code: "CLOSURE_REVIEW_APPLY_FAILED", message: apply.error ?? "approveAndApplyClosureReview returned ok=false" },
      side_effects: [],
    }
  }

  const sideEffects: SideEffect[] = []
  sideEffects.push({
    kind: apply.alreadyApplied ? "submission.review.already_applied" : "submission.reviewed",
    detail: apply.alreadyApplied
      ? `Submission ${submission.id} was already reviewed — proceeding with stage advance only`
      : `closure_submissions.reviewed_at set; drive.${apply.drive_save}`,
    ref_id: submission.id,
  })

  // ── 2. Advance SD stage ────────────────────────────────────────────
  const fromStage = ctx.task.task_meta && typeof ctx.task.task_meta === "object"
    ? (ctx.task.task_meta as Record<string, unknown>).sd_stage as string | undefined
    : undefined

  const advance = await advanceStage({
    delivery_id: ctx.task.delivery_id,
    target_stage: TARGET_STAGE,
    actor: `workflow:closure.approve_data:${ctx.actor.id}`,
    notes: `Closure data approved by workflow; submission ${submission.id}`,
  })
  if (!advance.success) {
    // Helper apply already succeeded — surface but don't fail the whole action,
    // task_meta still updates so admin sees the review-applied state.
    sideEffects.push({
      kind: "sd.advance.failed",
      detail: advance.error ?? "advanceStage returned success=false",
    })
    return {
      success: true,
      side_effects: sideEffects,
      task_meta_patch: {
        applied_at: new Date().toISOString(),
        submission_id: submission.id,
        sd_stage_advance_error: advance.error,
      },
      result: { submission_id: submission.id, sd_advanced: false, drive_save: apply.drive_save },
    }
  }

  sideEffects.push({
    kind: "sd.stage_advanced",
    detail: `${advance.from_stage} → ${advance.to_stage}`,
    ref_id: ctx.task.delivery_id,
    rollback: async () => {
      if (fromStage) {
        await advanceStage({
          delivery_id: ctx.task.delivery_id as string,
          target_stage: fromStage,
          actor: "workflow:closure.approve_data:rollback",
          notes: `Rollback from ${TARGET_STAGE}`,
        })
      }
    },
  })

  return {
    success: true,
    side_effects: sideEffects,
    task_meta_patch: {
      applied_at: new Date().toISOString(),
      submission_id: submission.id,
      sd_stage: advance.to_stage,
      sd_stage_at_action: advance.to_stage,
    },
    result: {
      submission_id: submission.id,
      already_applied: apply.alreadyApplied ?? false,
      drive_save: apply.drive_save,
      sd_advanced: true,
      sd_stage: advance.to_stage,
    },
  }
}
