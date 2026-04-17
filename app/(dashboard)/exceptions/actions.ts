"use server"

import { revalidatePath } from "next/cache"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { safeAction, type ActionResult } from "@/lib/server-action"
import { activateService } from "@/lib/operations/activation"
import { logAction } from "@/lib/mcp/action-log"

// ─── Retry partial activation ───────────────────────────────

export async function retryPartialActivation(
  pendingActivationId: string,
): Promise<ActionResult<{ outcome: string }>> {
  return safeAction(async () => {
    const result = await activateService({ pending_activation_id: pendingActivationId })
    if (!result.success && result.outcome !== "already_activated") {
      throw new Error(result.error || `Activation failed (${result.outcome})`)
    }
    revalidatePath("/exceptions")
    return { outcome: result.outcome }
  }, {
    action_type: "update",
    table_name: "pending_activations",
    record_id: pendingActivationId,
    summary: "Manual retry from Exception Center",
  })
}

// ─── Dismiss audit finding ──────────────────────────────────

export async function dismissAuditFinding(devTaskId: string): Promise<ActionResult> {
  return safeAction(async () => {
    // eslint-disable-next-line no-restricted-syntax -- dev_tasks is not a protected table; direct update is appropriate
    const { error } = await supabaseAdmin
      .from("dev_tasks")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", devTaskId)
    if (error) throw new Error(error.message)
    logAction({
      action_type: "update",
      table_name: "dev_tasks",
      record_id: devTaskId,
      summary: "Audit finding dismissed from Exception Center",
    })
    revalidatePath("/exceptions")
  })
}

// ─── Retry failed job ───────────────────────────────────────

export async function retryFailedJob(jobId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { error } = await supabaseAdmin
      .from("job_queue")
      .update({
        status: "pending",
        started_at: null,
        completed_at: null,
        error: null,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id", jobId)
    if (error) throw new Error(error.message)
    logAction({
      action_type: "update",
      table_name: "job_queue",
      record_id: jobId,
      summary: "Failed job requeued from Exception Center",
    })
    revalidatePath("/exceptions")
  })
}

// ─── Retry failed email ─────────────────────────────────────

export async function retryFailedEmail(emailId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { error } = await supabaseAdmin
      .from("email_queue")
      .update({
        status: "Queued",
        error_message: null,
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id", emailId)
    if (error) throw new Error(error.message)
    logAction({
      action_type: "update",
      table_name: "email_queue",
      record_id: emailId,
      summary: "Failed email requeued from Exception Center",
    })
    revalidatePath("/exceptions")
  })
}

// ─── Mark webhook reviewed ──────────────────────────────────

export async function markWebhookReviewed(webhookEventId: string): Promise<ActionResult> {
  return safeAction(async () => {
    const { error } = await supabaseAdmin
      .from("webhook_events")
      .update({ review_status: "reviewed" } as never)
      .eq("id", webhookEventId)
    if (error) throw new Error(error.message)
    logAction({
      action_type: "update",
      table_name: "webhook_events",
      record_id: webhookEventId,
      summary: "Webhook event marked reviewed from Exception Center",
    })
    revalidatePath("/exceptions")
  })
}
