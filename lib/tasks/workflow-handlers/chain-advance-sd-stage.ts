/**
 * chain.advance_sd_stage — Advance the parent task's linked service_delivery
 * to a target stage.
 *
 * Uses the canonical `advanceStage` helper from lib/operations/service-delivery.ts,
 * which logs the stage change to action_log and runs any pipeline_stages
 * auto_tasks/auto_actions configured for the target stage.
 *
 * Rollback: re-advance back to the previous stage. NOT idempotent against
 * pipeline_stages.auto_tasks — if the forward advance spawned a task and
 * rollback puts us back, the spawned task remains. This matches existing
 * crm-tracker behavior and is expected.
 *
 * Expected params shape (or fallback to action.handler_params):
 *   { target_stage: string }
 *
 * Requires the parent task to have a delivery_id; fails fast otherwise.
 */

import { advanceStage } from "@/lib/operations/service-delivery"
import { supabaseAdmin } from "@/lib/supabase-admin"
import type { HandlerContext, HandlerResult, WorkflowHandler } from "@/lib/tasks/types"

export const chainAdvanceSdStage: WorkflowHandler = async (
  ctx: HandlerContext,
): Promise<HandlerResult> => {
  if (!ctx.task.delivery_id) {
    return {
      success: false,
      error: {
        code: "NO_DELIVERY",
        message: "chain.advance_sd_stage requires the parent task to have a delivery_id",
      },
      side_effects: [],
    }
  }

  const params = (ctx.params ?? {}) as { target_stage?: unknown }
  const handlerParams = (ctx.action.handler_params ?? {}) as { target_stage?: unknown }
  const targetStage =
    typeof params.target_stage === "string"
      ? params.target_stage
      : typeof handlerParams.target_stage === "string"
        ? handlerParams.target_stage
        : ""

  if (!targetStage) {
    return {
      success: false,
      error: {
        code: "MISSING_TARGET_STAGE",
        message: "chain.advance_sd_stage requires 'target_stage' in params or action.handler_params",
      },
      side_effects: [],
    }
  }

  // Capture current stage for the rollback path and the preview.
  const { data: sd, error: sdErr } = await supabaseAdmin
    .from("service_deliveries")
    .select("stage")
    .eq("id", ctx.task.delivery_id)
    .single()
  if (sdErr || !sd) {
    return {
      success: false,
      error: { code: "SD_NOT_FOUND", message: `SD ${ctx.task.delivery_id} not found: ${sdErr?.message ?? "unknown"}` },
      side_effects: [],
    }
  }
  const fromStage = sd.stage ?? ""

  if (fromStage === targetStage) {
    return {
      success: true,
      side_effects: [{ kind: "sd.no_op", detail: `Already at stage '${targetStage}'` }],
      // sd_stage is the canonical "current stage" key read by TaskCard's
      // visibility_predicate filter (Slice 9). Kept in sync with the SD.
      task_meta_patch: { sd_stage_at_action: targetStage, sd_stage: targetStage },
    }
  }

  if (ctx.mode === "preview") {
    return {
      success: true,
      side_effects: [{ kind: "sd.advance.preview", detail: `${fromStage} → ${targetStage}` }],
      preview: { sd_stage_change: `${fromStage} → ${targetStage}` },
    }
  }

  const result = await advanceStage({
    delivery_id: ctx.task.delivery_id,
    target_stage: targetStage,
    actor: "workflow-dispatcher",
    notes: `Workflow ${ctx.workflow.slug}/${ctx.action.slug}`,
  })

  if (!result.success) {
    return {
      success: false,
      error: { code: "SD_ADVANCE_FAILED", message: result.error ?? "advanceStage returned success=false" },
      side_effects: [],
    }
  }

  const rollback = async () => {
    await advanceStage({
      delivery_id: ctx.task.delivery_id as string,
      target_stage: fromStage,
      actor: "workflow-dispatcher-rollback",
      notes: `Rollback from ${targetStage}`,
    })
  }

  return {
    success: true,
    side_effects: [
      {
        kind: "sd.stage_advanced",
        detail: `${result.from_stage} → ${result.to_stage}`,
        ref_id: ctx.task.delivery_id,
        rollback,
      },
    ],
    task_meta_patch: {
      sd_stage_at_action: result.to_stage,
      sd_stage_advanced_from: result.from_stage,
      // sd_stage = canonical current stage (read by TaskCard visibility filter)
      sd_stage: result.to_stage,
    },
    result: { from_stage: result.from_stage, to_stage: result.to_stage },
  }
}
