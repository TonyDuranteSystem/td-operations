/**
 * itin.recall_and_recorrect — Service-specific handler for retracting a
 * sent ITIN package and spawning a fresh review task.
 *
 * The email itself cannot be unsent; what we CAN do is hide the artifacts
 * the client would otherwise act on, revert the SD, and create a new
 * review task with the corrected data. The combined effect:
 *   1. portal_documents corresponding to the sent W-7 / 1040-NR / Schedule OI
 *      have portal_visible flipped to false (they vanish from the client's
 *      Documents tab).
 *   2. The portal_messages row from the original "ready for signature" notice
 *      is soft-deleted (R100) — client sees nothing in chat for the original.
 *   3. SD reverts Client Signing → Document Preparation so the workflow chain
 *      knows we're back in review mode.
 *   4. itin_submissions.status flips back to 'reviewed' so re-running
 *      itin_prepare_documents will overwrite the Drive PDFs cleanly.
 *   5. A new itin_review task is spawned with task_meta carrying the same
 *      submission_id; the auto-chain (Slice 5) or manual operator will
 *      re-trigger PDF generation with corrected data.
 *
 * Expected params shape:
 *   { reason?: string }   recorded on the new task's task_meta.recall_reason
 *
 * Rollbacks are tricky because the visible-side effects are the WHOLE POINT
 * of this handler. We track each step as a side_effect so the audit log
 * records what was hidden, but the side_effects[].rollback is intentionally
 * conservative — they only rollback the doc-hiding (re-show docs), not the
 * status flips, since the latter would defeat the purpose if a later step
 * fails. If you need to abort a recall mid-flight, prefer running the recall
 * a second time with corrected logic over rolling back.
 */

import { advanceStage } from "@/lib/operations/service-delivery"
import { createWorkflowTask } from "@/lib/operations/task"
import { supabaseAdmin } from "@/lib/supabase-admin"

/** Re-export the central client-safe schema for the workflow editor. */
export { itinRecallAndRecorrectParams as handlerParamsSchema } from "@/lib/tasks/handler-param-schemas"
import type { HandlerContext, HandlerResult, SideEffect, WorkflowHandler } from "@/lib/tasks/types"
import type { ItinReviewV1Meta } from "@/lib/tasks/workflow-schemas"

const RECALL_TARGET_STAGE = "Document Preparation"

export const itinRecallAndRecorrect: WorkflowHandler = async (
  ctx: HandlerContext,
): Promise<HandlerResult> => {
  const meta = ctx.task.task_meta as unknown as ItinReviewV1Meta
  const params = (ctx.params ?? {}) as { reason?: unknown }
  const reason = typeof params.reason === "string" ? params.reason.trim() : ""

  const sideEffects: SideEffect[] = []

  if (ctx.mode === "preview") {
    return {
      success: true,
      side_effects: [
        { kind: "documents.hide.preview", detail: `Would hide ${meta.attachments.length} portal documents` },
        { kind: "portal_message.recall.preview", detail: "Would soft-delete the recent ITIN notice" },
        { kind: "sd.advance.preview", detail: `Client Signing → ${RECALL_TARGET_STAGE}` },
        { kind: "workflow.spawn.preview", detail: "Would spawn a fresh itin_review task" },
      ],
      preview: {
        sd_stage_change: `Client Signing → ${RECALL_TARGET_STAGE}`,
      },
    }
  }

  // ── 1. Hide portal-visible documents ────────────────────────────────
  const fileIds = meta.attachments.map((a) => a.file_id)
  const { data: hiddenDocs, error: hideErr } = await supabaseAdmin
    .from("documents")
    .update({ portal_visible: false, updated_at: new Date().toISOString() })
    .in("drive_file_id", fileIds)
    .select("id")
  if (hideErr) {
    return {
      success: false,
      error: { code: "DOC_HIDE_FAILED", message: hideErr.message },
      side_effects: [],
    }
  }
  const hiddenIds = (hiddenDocs ?? []).map((d) => d.id)
  sideEffects.push({
    kind: "documents.hidden",
    detail: `${hiddenIds.length} portal documents hidden`,
    rollback: async () => {
      if (hiddenIds.length > 0) {
        await supabaseAdmin
          .from("documents")
          .update({ portal_visible: true, updated_at: new Date().toISOString() })
          .in("id", hiddenIds)
      }
    },
  })

  // ── 2. Soft-delete the most recent portal_messages row tied to this task ─
  const lastPortalMessageId =
    typeof (ctx.task.task_meta as Record<string, unknown>)?.portal_message_id === "string"
      ? ((ctx.task.task_meta as Record<string, unknown>).portal_message_id as string)
      : null
  if (lastPortalMessageId) {
    const { error: delErr } = await supabaseAdmin
      .from("portal_messages")
      .update({ deleted_at: new Date().toISOString(), deleted_by: ctx.actor.id })
      .eq("id", lastPortalMessageId)
    if (delErr) {
      // Non-fatal: hidden docs are the load-bearing part. Log + continue.
      console.warn("[itin.recall_and_recorrect] portal_messages soft-delete failed:", delErr.message)
    } else {
      sideEffects.push({
        kind: "portal_message.soft_deleted",
        detail: "Original ITIN notice hidden from client",
        ref_id: lastPortalMessageId,
      })
    }
  }

  // ── 3. Revert SD stage ─────────────────────────────────────────────
  if (ctx.task.delivery_id) {
    const { data: sd } = await supabaseAdmin
      .from("service_deliveries")
      .select("stage")
      .eq("id", ctx.task.delivery_id)
      .maybeSingle()
    const fromStage = sd?.stage ?? ""
    if (fromStage && fromStage !== RECALL_TARGET_STAGE) {
      const advance = await advanceStage({
        delivery_id: ctx.task.delivery_id,
        target_stage: RECALL_TARGET_STAGE,
        actor: "workflow:itin.recall_and_recorrect",
        notes: reason ? `Recalled — reason: ${reason}` : "Recalled by operator",
        skip_tasks: true,
      })
      if (!advance.success) {
        return {
          success: false,
          error: {
            code: "SD_REVERT_FAILED",
            message: advance.error ?? "advanceStage returned success=false",
            partial_state: { hidden_document_ids: hiddenIds },
          },
          side_effects: sideEffects,
        }
      }
      sideEffects.push({
        kind: "sd.stage_reverted",
        detail: `${advance.from_stage} → ${advance.to_stage}`,
        ref_id: ctx.task.delivery_id,
      })
    }
  }

  // ── 4. Best-effort: flip itin_submissions.status so re-generation is clean ─
  try {
    await supabaseAdmin
      .from("itin_submissions")
      .update({ status: "reviewed", updated_at: new Date().toISOString() })
      .eq("id", meta.submission_id)
  } catch (err) {
    console.warn("[itin.recall_and_recorrect] itin_submissions status reset failed:", err)
  }

  // ── 5. Spawn a fresh itin_review task ──────────────────────────────
  // The dispatcher itself handles spawn_task using HandlerResult.spawn_task,
  // but for itin specifically the spawned task needs the same workflow
  // snapshot pinned at creation — which is the dispatcher's job in Slice 5
  // (it looks up the catalog row when workflow_snapshot is empty on the
  // spawned task). At Slice 4 we create the new task here with the snapshot
  // already populated by copying it from the current task.
  const newTaskMeta: Record<string, unknown> = {
    submission_id: meta.submission_id,
    drive_folder_id: meta.drive_folder_id,
    attachments: meta.attachments,
    generated_at: new Date().toISOString(),
    client_language: meta.client_language,
    client_email: meta.client_email,
    client_first_name: meta.client_first_name,
    client_last_name: meta.client_last_name,
    recall_reason: reason || "(no reason supplied)",
    spawned_from_task_id: ctx.task.id,
  }
  const spawn = await createWorkflowTask({
    workflow_slug: "itin_review",
    workflow_snapshot: ctx.workflow as unknown as Record<string, unknown>,
    task_meta: newTaskMeta,
    task_title: `Review ITIN documents — ${meta.client_first_name} ${meta.client_last_name} (RECALL)`,
    assigned_to: ctx.task.assigned_to,
    status: "To Do",
    priority: "High",
    account_id: ctx.task.account_id,
    deal_id: ctx.task.deal_id,
    service_id: ctx.task.service_id,
    delivery_id: ctx.task.delivery_id,
    contact_id: ctx.task.contact_id,
    actor: "workflow:itin.recall_and_recorrect",
    summary: "Re-review after recall",
    details: { parent_task_id: ctx.task.id, recall_reason: reason },
  })
  if (!spawn.success) {
    console.warn("[itin.recall_and_recorrect] spawn re-review task failed:", spawn.error)
  } else {
    sideEffects.push({
      kind: "task.spawned",
      detail: `New itin_review task ${spawn.task_id}`,
      ref_id: spawn.task_id,
    })
  }

  return {
    success: true,
    side_effects: sideEffects,
    task_meta_patch: {
      recalled_at: new Date().toISOString(),
      recall_reason: reason || "(no reason supplied)",
      recall_spawned_task_id: spawn.task_id ?? null,
    },
    result: {
      hidden_documents: hiddenIds.length,
      spawned_task_id: spawn.task_id ?? null,
    },
  }
}
