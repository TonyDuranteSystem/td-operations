/**
 * tax.approve_and_apply — Workflow handler for tax_form_review.
 *
 * Composes:
 *   1. lib/operations/tax-review.ts::approveAndApplyTaxReview
 *      (shared with MCP tool tax_form_review; enqueues the tax_form_setup
 *       background job which does the heavy lifting — contact + account +
 *       tax_returns + form review flag).
 *
 * The auto-chain (/api/tax-form-completed) already handled email, contact
 * field sync (if changed), passport check, tax_returns advance to
 * "Data Received", SD advance, Drive save, and P&L auto-parse (MMLLC/Corp).
 * This handler only kicks off the post-review reconciliation job.
 *
 * task_meta MUST conform to WORKFLOW_SCHEMAS.tax_form_review_v1.
 */

import { approveAndApplyTaxReview } from "@/lib/operations/tax-review"
import type { HandlerContext, HandlerResult, SideEffect, WorkflowHandler } from "@/lib/tasks/types"
import type { TaxFormReviewV1Meta } from "@/lib/tasks/workflow-schemas"

/** Re-export the central client-safe schema for the workflow editor. */
export { taxApproveAndApplyParams as handlerParamsSchema } from "@/lib/tasks/handler-param-schemas"

export const taxApproveAndApply: WorkflowHandler = async (
  ctx: HandlerContext,
): Promise<HandlerResult> => {
  const meta = ctx.task.task_meta as unknown as TaxFormReviewV1Meta

  if (ctx.mode === "preview") {
    return {
      success: true,
      side_effects: [
        { kind: "submission.review.preview", detail: `Would mark submission ${meta.submission_id} reviewed` },
        { kind: "job.enqueue.preview", detail: `Would enqueue tax_form_setup job (CRM reconciliation)` },
      ],
      preview: {
        portal_message: `Background job will reconcile contact + account + tax_returns for ${meta.company_name} (${meta.tax_year}).`,
      },
    }
  }

  const result = await approveAndApplyTaxReview({
    submission_id: meta.submission_id,
    actor: `workflow:tax.approve_and_apply:${ctx.actor.id}`,
  })

  if (!result.ok) {
    return {
      success: false,
      error: { code: "TAX_REVIEW_APPLY_FAILED", message: result.error ?? "approveAndApplyTaxReview returned ok=false" },
      side_effects: [],
    }
  }

  const sideEffects: SideEffect[] = []

  if (result.alreadyApplied) {
    sideEffects.push({
      kind: "submission.review.already_applied",
      detail: `Submission ${meta.submission_id} was already reviewed — no job re-enqueued`,
    })
    return {
      success: true,
      side_effects: sideEffects,
      task_meta_patch: { applied_at_existing: true },
      result: { already_applied: true },
    }
  }

  sideEffects.push({
    kind: "submission.reviewed",
    detail: `tax_return_submissions.reviewed_at set`,
    ref_id: meta.submission_id,
  })
  if (result.job_id) {
    sideEffects.push({
      kind: "job.enqueued",
      detail: `tax_form_setup job ${result.job_id} (priority 1)`,
      ref_id: result.job_id,
      // No rollback — the job is async and may have already started by the time
      // a rollback would fire. Cancellation of in-flight jobs isn't supported.
    })
  }

  return {
    success: true,
    side_effects: sideEffects,
    task_meta_patch: {
      applied_at: new Date().toISOString(),
      job_id: result.job_id,
    },
    result: {
      job_id: result.job_id,
      tax_year: result.tax_year,
    },
  }
}
