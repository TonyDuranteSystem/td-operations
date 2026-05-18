/**
 * sd.mark_complete — Generic primitive for closing an SD-lifecycle workflow.
 *
 * Slice 9. The final action of closure_progress, formation_progress, and
 * onboarding_progress all do the same shape: close the SD (status='completed'
 * + close_date), optionally spawn next-step SDs (RA Renewal, Annual Report,
 * etc.), optionally send a portal review-request notification.
 *
 * Per-workflow variations live in handler_params:
 *   - spawn_next_sds: string[]   list of service_type strings to createSD for
 *   - send_review_request: bool  if true, send the "leave us a review" portal
 *                                notification to the primary contact
 *
 * Zero new code per future SD-lifecycle workflow — just a catalog row that
 * references sd.mark_complete with appropriate handler_params.
 *
 * Note: the createSD calls each fire their OWN dispatcher hook, which could
 * recursively spawn workflow tasks for the new SDs (e.g. RA Renewal SD might
 * have its own future RA Renewal workflow). That's the intended behavior —
 * the system composes cleanly.
 */

import { createSD } from "@/lib/operations/service-delivery"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { defaultTaskAssignee } from "@/lib/tasks/default-assignee"
import type { HandlerContext, HandlerResult, SideEffect, WorkflowHandler } from "@/lib/tasks/types"

/** Re-export the central client-safe schema for the workflow editor. */
export { sdMarkCompleteParams as handlerParamsSchema } from "@/lib/tasks/handler-param-schemas"

interface MarkCompleteParams {
  spawn_next_sds?: string[]
  send_review_request?: boolean
}

export const sdMarkComplete: WorkflowHandler = async (
  ctx: HandlerContext,
): Promise<HandlerResult> => {
  if (!ctx.task.delivery_id) {
    return {
      success: false,
      error: { code: "NO_DELIVERY", message: "sd.mark_complete requires task.delivery_id" },
      side_effects: [],
    }
  }

  const handlerParams = (ctx.action.handler_params ?? {}) as MarkCompleteParams
  const spawnTypes = Array.isArray(handlerParams.spawn_next_sds) ? handlerParams.spawn_next_sds : []
  const sendReview = handlerParams.send_review_request === true

  if (ctx.mode === "preview") {
    const previews: SideEffect[] = [
      { kind: "sd.close.preview", detail: `Would mark SD ${ctx.task.delivery_id} status='completed'` },
    ]
    for (const svc of spawnTypes) {
      previews.push({ kind: "sd.spawn.preview", detail: `Would createSD(service_type='${svc}')` })
    }
    if (sendReview) {
      previews.push({ kind: "review_request.preview", detail: "Would send portal review-request notification" })
    }
    return { success: true, side_effects: previews }
  }

  const sideEffects: SideEffect[] = []

  // ── 1. Close the SD ───────────────────────────────────────────────
  const { data: before } = await supabaseAdmin
    .from("service_deliveries")
    .select("status, end_date, account_id, contact_id")
    .eq("id", ctx.task.delivery_id)
    .maybeSingle()
  if (!before) {
    return {
      success: false,
      error: { code: "SD_NOT_FOUND", message: `SD ${ctx.task.delivery_id} not found` },
      side_effects: [],
    }
  }

  if (before.status === "completed") {
    sideEffects.push({ kind: "sd.close.no_op", detail: `SD ${ctx.task.delivery_id} already completed` })
  } else {
    const today = new Date().toISOString().split("T")[0]
    // eslint-disable-next-line no-restricted-syntax -- SD close is a workflow primitive operation; the SD-operations layer's advanceStage doesn't have a "close" verb. Adding one is a separate refactor tracked in dev_task fda76fd3.
    const { error: closeErr } = await supabaseAdmin
      .from("service_deliveries")
      .update({ status: "completed", end_date: today, updated_at: new Date().toISOString() })
      .eq("id", ctx.task.delivery_id)
    if (closeErr) {
      return {
        success: false,
        error: { code: "SD_CLOSE_FAILED", message: closeErr.message },
        side_effects: [],
      }
    }
    sideEffects.push({
      kind: "sd.closed",
      detail: `SD ${ctx.task.delivery_id} marked completed (end_date ${today})`,
      ref_id: ctx.task.delivery_id,
      rollback: async () => {
        // eslint-disable-next-line no-restricted-syntax -- inline rollback of self-issued SD close; mirrors the forward write above.
        await supabaseAdmin
          .from("service_deliveries")
          .update({ status: before.status, end_date: before.end_date, updated_at: new Date().toISOString() })
          .eq("id", ctx.task.delivery_id as string)
      },
    })
  }

  // ── 2. Spawn next-step SDs ────────────────────────────────────────
  const spawnedSds: Array<{ service_type: string; sd_id: string | null; error?: string }> = []
  for (const serviceType of spawnTypes) {
    try {
      // Don't double-spawn: skip if there's already an active SD of this type for the same account.
      if (before.account_id) {
        const { data: existing } = await supabaseAdmin
          .from("service_deliveries")
          .select("id")
          .eq("account_id", before.account_id)
          .eq("service_type", serviceType)
          .eq("status", "active")
          .limit(1)
          .maybeSingle()
        if (existing) {
          spawnedSds.push({ service_type: serviceType, sd_id: existing.id })
          sideEffects.push({
            kind: "sd.spawn.skipped",
            detail: `Active ${serviceType} SD already exists for this account (${existing.id})`,
            ref_id: existing.id,
          })
          continue
        }
      }
      const sd = await createSD({
        service_type: serviceType,
        account_id: before.account_id ?? undefined,
        contact_id: before.contact_id ?? undefined,
        assigned_to: ctx.workflow.default_assignee ?? defaultTaskAssignee(),
        notes: `Auto-spawned by sd.mark_complete from workflow ${ctx.workflow.slug}`,
      })
      spawnedSds.push({ service_type: serviceType, sd_id: sd.id })
      sideEffects.push({
        kind: "sd.spawned",
        detail: `Created ${serviceType} SD (${sd.id})`,
        ref_id: sd.id,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      spawnedSds.push({ service_type: serviceType, sd_id: null, error: msg })
      sideEffects.push({
        kind: "sd.spawn.failed",
        detail: `Failed to createSD(${serviceType}): ${msg}`,
      })
    }
  }

  // ── 3. Send review request (best-effort) ──────────────────────────
  if (sendReview && before.account_id) {
    try {
      const { createPortalNotification } = await import("@/lib/portal/notifications")
      await createPortalNotification({
        account_id: before.account_id,
        contact_id: before.contact_id ?? undefined,
        type: "chat",
        title: "Your service is complete — please leave us a review",
        body: "We'd love to hear about your experience. A quick review on Google or Trustpilot helps us a lot.",
        link: "/portal/dashboard",
      })
      sideEffects.push({ kind: "review_request.sent", detail: "Portal review-request notification sent" })
    } catch (err) {
      sideEffects.push({
        kind: "review_request.failed",
        detail: `Portal notification failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  return {
    success: true,
    side_effects: sideEffects,
    task_meta_patch: {
      completed_at: new Date().toISOString(),
      sd_stage: "Completed",
      spawned_sds: spawnedSds,
    },
    result: {
      sd_id: ctx.task.delivery_id,
      spawned_sds: spawnedSds,
      review_request_sent: sendReview && !!before.account_id,
    },
  }
}
