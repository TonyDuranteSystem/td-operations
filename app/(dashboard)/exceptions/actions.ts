"use server"

import { revalidatePath } from "next/cache"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { safeAction, type ActionResult } from "@/lib/server-action"
import { activateService } from "@/lib/operations/activation"
import { reconcileTier } from "@/lib/operations/portal"
import { enqueueJob } from "@/lib/jobs/queue"
import { logAction } from "@/lib/mcp/action-log"
import type { PortalTier } from "@/lib/portal/tier-config"

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

// ─── Reconcile portal tier drift ────────────────────────────
// Admin picks a target_tier (usually either the contact's or the account's
// current value) and reconcileTier() syncs contact + accounts + auth in one
// atomic op. Source-of-truth rule: contacts.portal_tier — but the admin can
// override here because drift means the "source of truth" is itself wrong.

export async function reconcileTierFromException(
  contactId: string,
  targetTier: PortalTier,
): Promise<ActionResult<{ resolved_tier: string | null; changed_count: number }>> {
  return safeAction(async () => {
    const result = await reconcileTier({ contact_id: contactId, target_tier: targetTier })
    if (!result.success) throw new Error(result.error || "Reconcile failed")
    const changed =
      (result.changed.contact ? 1 : 0) +
      result.changed.accounts.length +
      (result.changed.auth_user ? 1 : 0)
    logAction({
      action_type: "update",
      table_name: "contacts",
      record_id: contactId,
      summary: `Reconciled portal tier → ${result.resolved_tier} from Exception Center (${changed} layer(s) updated)`,
      details: { target_tier: targetTier, changed: result.changed },
    })
    revalidatePath("/exceptions")
    return { resolved_tier: result.resolved_tier, changed_count: changed }
  })
}

// ─── Retry a silent-failed job (clones payload into a new pending row) ──
// The original job is stuck at status='completed' — we can't re-run it in
// place without breaking the job_queue invariants. Enqueueing a fresh copy
// is the clean path: same job_type + payload, same priority.

export async function retrySilentFailedJob(
  jobId: string,
): Promise<ActionResult<{ new_job_id: string }>> {
  return safeAction(async () => {
    const { data: original, error: readErr } = await supabaseAdmin
      .from("job_queue")
      .select("job_type, payload, priority, max_attempts, account_id, lead_id")
      .eq("id", jobId)
      .single()
    if (readErr || !original) throw new Error(readErr?.message || "Job not found")

    const newJob = await enqueueJob({
      job_type: original.job_type,
      payload: original.payload as Record<string, unknown>,
      priority: original.priority ?? 5,
      max_attempts: original.max_attempts ?? 3,
      account_id: original.account_id ?? undefined,
      lead_id: original.lead_id ?? undefined,
      created_by: "exception-center-retry",
    })

    logAction({
      action_type: "create",
      table_name: "job_queue",
      record_id: newJob.id,
      summary: `Retry of silent-failed job ${jobId} from Exception Center`,
      details: { original_job_id: jobId, job_type: original.job_type },
    })
    revalidatePath("/exceptions")
    return { new_job_id: newJob.id }
  })
}

// ─── Close an orphan task (mark cancelled) ──────────────────

export async function closeOrphanTask(taskId: string): Promise<ActionResult> {
  return safeAction(async () => {
    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
    const { error } = await supabaseAdmin
      .from("tasks")
      .update({ status: "Cancelled", updated_at: new Date().toISOString() })
      .eq("id", taskId)
    if (error) throw new Error(error.message)
    logAction({
      action_type: "update",
      table_name: "tasks",
      record_id: taskId,
      summary: "Orphan task cancelled from Exception Center",
    })
    revalidatePath("/exceptions")
  })
}

// ─── Resolve a quarantined statement format (card 4a39e0fd) ─────────────────

export async function resolveStatementFormat(
  mappingId: string,
  decision: "confirm" | "reject",
): Promise<ActionResult<{ requeued: number }>> {
  return safeAction(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any // statement_format_mappings not in generated types
    const { data: mapping } = await db
      .from("statement_format_mappings")
      .select("id, status, bank_label")
      .eq("id", mappingId)
      .maybeSingle()
    if (!mapping) throw new Error("Format proposal not found.")
    if (mapping.status !== "proposed") throw new Error(`Already ${String(mapping.status).replace("_", " ")}.`)

    const nextStatus = decision === "confirm" ? "staff_confirmed" : "rejected"
    const { error } = await db
      .from("statement_format_mappings")
      .update({ status: nextStatus, updated_at: new Date().toISOString() })
      .eq("id", mappingId)
      .eq("status", "proposed") // TOCTOU: one resolver wins
    if (error) throw new Error(error.message)

    // Antonio's ruling: a confirmed format RE-PROCESSES every waiting client
    // file automatically — a client must never sit stuck behind a format we
    // already approved.
    let requeued = 0
    if (decision === "confirm") {
      const { requeueQuarantinedPortalIngests } = await import("@/lib/tax/quarantine-requeue")
      const r = await requeueQuarantinedPortalIngests(mappingId)
      requeued = r.requeued
    }
    revalidatePath("/exceptions")
    return { requeued }
  }, {
    action_type: "update",
    table_name: "statement_format_mappings",
    record_id: mappingId,
    summary: `Statement format ${decision === "confirm" ? "confirmed" : "rejected"} from Exception Center`,
  })
}

// ─── Unlock the client's Confirm after a failed statement file (W9) ─────────

export async function unlockConfirmFromException(
  accountId: string,
  taxYear: number,
  reason: string,
): Promise<ActionResult> {
  return safeAction(async () => {
    // The override history must name WHO unlocked (the ruling: logged means
    // attributable) — resolve the signed-in staff member, never a surface name.
    const { createClient } = await import("@/lib/supabase/server")
    const { data: { user } } = await createClient().auth.getUser()
    const { unlockFinancialsConfirm } = await import("@/lib/tax/confirm-unlock")
    const r = await unlockFinancialsConfirm({
      accountId, taxYear, reason,
      actor: user?.email ?? "exception-center",
    })
    if (!r.ok) throw new Error(r.error || "Could not unlock.")
    revalidatePath("/exceptions")
  })
}
