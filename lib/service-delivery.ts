/**
 * advanceServiceDelivery — Shared service delivery stage advancement logic.
 *
 * Used by BOTH:
 *   - CRM Tracker drag-and-drop (app/(dashboard)/trackers/[serviceType]/actions.ts)
 *   - MCP sd_advance_stage tool (lib/mcp/tools/operations.ts)
 *
 * This is the SINGLE SOURCE OF TRUTH for what happens when a service delivery
 * advances to a new stage. All auto-workflows must be here, not duplicated.
 *
 * Workflows triggered on stage advance:
 *   1. Stage history tracking (JSONB log)
 *   2. Auto-task creation from pipeline_stages.auto_tasks
 *   3. Portal tier upgrade (active → full on EIN Received / completion / late-stage)
 *   4. Portal notification to client
 *   5. Tax Return sync (SD stage → tax_returns status + date fields)
 *   6. RA Renewal date +1 year on completion
 *   7. Annual Report deadline +1 year on completion
 *   8. Company Formation renewal date initialization (on Articles Received)
 *   9. Welcome package enqueue (on Articles Received)
 *   10. Company Closure cascade (cancel SDs, deactivate account/portal, closure tasks)
 *   11. Action log entry
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { formationStateFromWizardData, resolveFormationStateCode } from "@/lib/formation/states"
import { formationStateForClient } from "@/lib/formation/state-lookup"
import { dbWrite, dbWriteSafe } from "@/lib/db"
import { logAction } from "@/lib/mcp/action-log"
import { ACCOUNT_STATUS } from "@/lib/constants"
import { filedName, type NameCheck } from "@/lib/flows/name-checks"

// ─── Types ────────────────────────────────────────────────

export interface AdvanceStageParams {
  delivery_id: string
  target_stage?: string
  skip_tasks?: boolean
  /**
   * Suppress all CLIENT-FACING notifications for this advance (portal
   * notification, web-push, and the milestone email). Used by bulk
   * reconciliation/backfills so correcting many SDs at once does not spam
   * clients. Does NOT affect stage_history / action_log / tax_returns sync.
   */
  skip_notify?: boolean
  notes?: string
  actor?: string // "crm-tracker" | "mcp" | etc.
  /**
   * Formation date (ISO YYYY-MM-DD) confirmed by staff when advancing a Company
   * Formation SD into "Articles Received". Passed straight to
   * materializeFormationCompany so the SS-4 Line 11 ("date business started")
   * reflects the real state filing date — NOT the day the company was processed
   * in the CRM (the old default-to-today bug). Ignored for other transitions.
   */
  formation_date?: string
  /**
   * Staff-supplied LLC type for the Company Formation advance into "Articles
   * Received" — the materializer's highest-priority entity-type source. Sent
   * by the workspace Articles-upload modal when the automatic resolution
   * (signed contract → formation form → wizard data) cannot determine the
   * type (the Covelli/DoctorGut case). Ignored for other transitions.
   */
  entity_type?: "SMLLC" | "MMLLC"
}

export interface AdvanceStageResult {
  success: boolean
  error?: string
  from_stage: string
  to_stage: string
  to_order: number
  total_stages: number
  is_completed: boolean
  created_tasks: string[]
  failed_tasks: { title: string; error: string }[]
  auto_triggers: string[] // human-readable log of what auto-workflows ran
  requires_approval?: boolean
  sla_days?: number | null
  /**
   * Company-Formation materialization outcome, set ONLY on an advance into
   * "Articles Received" for a not-yet-materialized formation. Deterministic
   * failures (no data / no name / no entity type) never reach here — they
   * REFUSE the advance up-front (success:false). This field reports the
   * RUNTIME outcome so callers can surface a structured warning instead of
   * grepping the free-text auto_triggers (the Covelli silent-failure fix).
   */
  materialization?: {
    attempted: boolean
    outcome: string
    account_id?: string
    error?: string
  }
}

// ─── Main function ────────────────────────────────────────

export async function advanceServiceDelivery(
  params: AdvanceStageParams,
): Promise<AdvanceStageResult> {
  const { delivery_id, target_stage, skip_tasks = false, skip_notify = false, notes, actor = "system" } = params

  // 1. Get current delivery
  const { data: delivery, error: dErr } = await supabaseAdmin
    .from("service_deliveries")
    .select("*")
    .eq("id", delivery_id)
    .single()
  if (dErr || !delivery) throw new Error("Service delivery not found")

  // 2. Get pipeline stages for this service type
  const { data: stages, error: sErr } = await supabaseAdmin
    .from("pipeline_stages")
    .select("*")
    .eq("service_type", delivery.service_type)
    .order("stage_order")
  if (sErr || !stages?.length) throw new Error(`No pipeline stages defined for service_type: ${delivery.service_type}`)

  // 3. Determine current and target stage
  const currentOrder = delivery.stage_order || 0
  let targetStage: typeof stages[0]

  if (target_stage) {
    const found = stages.find(s => s.stage_name.toLowerCase() === target_stage.toLowerCase())
    if (!found) throw new Error(`Stage "${target_stage}" not found. Available: ${stages.map(s => s.stage_name).join(", ")}`)
    targetStage = found
  } else {
    // Block auto-advance from intake-only stages (stage_order ≤ 0, explicitly set).
    // These stages have context-dependent next steps that require explicit target_stage.
    // SDs with stage_order=null (legacy) are unaffected — they resolve to currentOrder=0
    // via the || 0 fallback, but delivery.stage_order is still null.
    if (delivery.stage_order !== null && delivery.stage_order <= 0) {
      throw new Error(
        `Stage "${delivery.stage}" (order ${delivery.stage_order}) requires explicit target_stage for advancement. ` +
        `Available: ${stages.map(s => s.stage_name).join(", ")}`
      )
    }
    const nextStage = stages.find(s => s.stage_order > currentOrder)
    if (!nextStage) throw new Error("Already at final stage")
    targetStage = nextStage
  }

  // 4. Check if current stage requires approval
  if (currentOrder > 0) {
    const currentStageObj = stages.find(s => s.stage_order === currentOrder)
    if (currentStageObj?.requires_approval) {
      const { data: approvalTasks } = await supabaseAdmin
        .from("tasks")
        .select("id, status")
        .eq("account_id", delivery.account_id)
        .ilike("task_title", `%quality check%`)
        .in("status", ["To Do", "In Progress"])
        .limit(1)
      if (approvalTasks?.length) {
        return {
          success: false,
          error: `Current stage "${currentStageObj.stage_name}" requires approval. Complete the approval task first.`,
          from_stage: delivery.stage || "New",
          to_stage: targetStage.stage_name,
          to_order: targetStage.stage_order,
          total_stages: stages.length,
          is_completed: false,
          created_tasks: [],
          failed_tasks: [],
          auto_triggers: [],
          requires_approval: true,
        }
      }
    }
  }

  // 4b. Company Formation — REFUSE the advance into "Articles Received" when
  // the company cannot be materialized for a DETERMINISTIC data reason (no
  // formation data / no confirmed filed name / unresolvable entity type).
  // Before this gate the stage move committed first and the materialization
  // failure was only appended to auto_triggers — which no workspace surface
  // rendered — so staff saw success while no account existed and the SS-4
  // panel then dead-ended (Covelli/DoctorGut, 2026-07-28). Deterministic
  // gates are checkable up-front; transient runtime errors (Drive/network)
  // in section 11b below still fail soft with a structured warning. The admin
  // Upload Articles route already blocks on failure — this makes the flow
  // paths consistent with it.
  if (
    delivery.service_type === "Company Formation" &&
    targetStage.stage_name === "Articles Received" &&
    !delivery.account_id &&
    delivery.contact_id
  ) {
    try {
      const { preflightFormationMaterialization } = await import("@/lib/operations/formation-materialize")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- name_checks not in generated types
      const { data: preNcRow } = await (supabaseAdmin as any)
        .from("service_deliveries")
        .select("name_checks")
        .eq("id", delivery_id)
        .maybeSingle()
      const preConfirmedName = filedName((preNcRow?.name_checks as NameCheck[] | null) ?? null)
      const pre = await preflightFormationMaterialization({
        contact_id: delivery.contact_id,
        chosen_name: preConfirmedName,
        entity_type: params.entity_type ?? null,
      })
      if (!pre.ok) {
        const hint =
          pre.failure === "missing_entity_type"
            ? " Choose the LLC type (single- or multi-member) in the Articles upload dialog, or record it on the signed contract, then retry."
            : pre.failure === "missing_chosen_name"
              ? " Mark the state-approved name as filed in Name Checks first, then retry."
              : ""
        return {
          success: false,
          error: `Cannot create the company record: ${pre.error ?? "unknown reason"}${hint}`,
          from_stage: delivery.stage || "New",
          to_stage: targetStage.stage_name,
          to_order: targetStage.stage_order,
          total_stages: stages.length,
          is_completed: false,
          created_tasks: [],
          failed_tasks: [],
          auto_triggers: [],
        }
      }
    } catch (preErr) {
      // The preflight is a guard, not a new failure mode: if the CHECK itself
      // errors (transient read), fall through — section 11b keeps its
      // resilient fail-soft behavior and reports via `materialization`.
      console.warn("[advanceServiceDelivery] formation materialize preflight failed (non-blocking):", preErr)
    }
  }

  // 5. Build stage history entry
  const historyEntry = {
    from_stage: delivery.stage || "New",
    from_order: currentOrder,
    to_stage: targetStage.stage_name,
    to_order: targetStage.stage_order,
    advanced_at: new Date().toISOString(),
    advanced_by: actor,
    notes: notes || null,
  }
  const stageHistory = Array.isArray(delivery.stage_history) ? [...delivery.stage_history, historyEntry] : [historyEntry]

  // 6. Update delivery
  // "Closed" is the final stage for the recurring renewal flows (State Annual
  // Report / State RA Renewal — verified the only two service types with a
  // "Closed" stage). Treating it as completed here is what fires the +1-year
  // renewal-date bump (sections 10/11), sets status=completed + end_date, and
  // sends the "is complete!" portal notification. Scoped by service_type so no
  // other flow that might name a stage "Closed" is affected.
  const isClosedRenewalFinal =
    targetStage.stage_name === "Closed" &&
    (delivery.service_type === "State Annual Report" || delivery.service_type === "State RA Renewal")
  const isCompleted =
    targetStage.stage_name === "Completed" ||
    targetStage.stage_name === "TR Filed" ||
    isClosedRenewalFinal
  await dbWrite(
    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
    supabaseAdmin
      .from("service_deliveries")
      .update({
        stage: targetStage.stage_name,
        stage_order: targetStage.stage_order,
        stage_entered_at: new Date().toISOString(),
        stage_history: stageHistory,
        status: isCompleted ? "completed" : "active",
        ...(isCompleted ? { end_date: new Date().toISOString().split("T")[0] } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", delivery_id),
    "service_deliveries.update"
  )

  const autoTriggers: string[] = []

  // 6b. Sync the workspace-pointer workflow task's task_meta with the new SD
  // stage. The workspace advances the SD through THIS function, a different path
  // from the workflow engine's chain.advance_sd_stage handler (which already
  // patches task_meta) — so without this the pointer task card showed a stale
  // stage. Both formation_progress (Company Formation) and itin_review (ITIN)
  // are read-only workspace pointers, so this only keeps their displayed stage
  // honest. Best-effort: never fail the advance.
  const POINTER_WORKFLOW_SLUG_BY_SERVICE: Record<string, string> = {
    "Company Formation": "formation_progress",
    "ITIN": "itin_review",
  }
  const pointerWorkflowSlug = POINTER_WORKFLOW_SLUG_BY_SERVICE[delivery.service_type]
  if (pointerWorkflowSlug) {
    try {
      const { mergeSdStageIntoTaskMeta } = await import("@/lib/tasks/sd-stage-sync")
      const { data: wfTasks } = await supabaseAdmin
        .from("tasks")
        .select("id, task_meta")
        .eq("workflow_slug", pointerWorkflowSlug)
        .or(`delivery_id.eq.${delivery_id},task_meta->>service_delivery_id.eq.${delivery_id}`)
      for (const t of wfTasks ?? []) {
        await dbWriteSafe(
          // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
          supabaseAdmin
            .from("tasks")
            .update({
              task_meta: mergeSdStageIntoTaskMeta(
                t.task_meta as Record<string, unknown> | null,
                targetStage.stage_name,
              ) as never,
              updated_at: new Date().toISOString(),
            })
            .eq("id", t.id),
          "tasks.update",
        )
      }
      if (wfTasks?.length) {
        autoTriggers.push(
          `Synced ${wfTasks.length} ${pointerWorkflowSlug} task(s) → sd_stage="${targetStage.stage_name}"`,
        )
      }
    } catch (syncErr) {
      autoTriggers.push(
        `Workflow task stage sync failed: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`,
      )
    }
  }

  // 7. Create auto-tasks (unless skipped)
  const createdTasks: string[] = []
  const failedTasks: { title: string; error: string }[] = []
  if (!skip_tasks && targetStage.auto_tasks && Array.isArray(targetStage.auto_tasks)) {
    for (const taskDef of targetStage.auto_tasks as Array<{ title: string; assigned_to: string; category: string; priority: string; description?: string }>) {
      const { error: tErr } = await dbWriteSafe(
        // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
        supabaseAdmin
          .from("tasks")
          .insert({
            task_title: `[${delivery.service_name || delivery.service_type}] ${taskDef.title}`,
            assigned_to: taskDef.assigned_to || "Luca",
            category: (taskDef.category || "Internal") as never,
            priority: (taskDef.priority || "Normal") as never,
            description: taskDef.description || `Auto-created by pipeline advance to "${targetStage.stage_name}"`,
            status: "To Do",
            // Phase 1 ITIN rule (2026-05-11): propagate contact_id so contact-
            // only SDs (account_id=null) still produce attributable tasks.
            account_id: delivery.account_id,
            contact_id: delivery.contact_id,
            deal_id: delivery.deal_id,
            delivery_id: delivery.id,
            stage_order: targetStage.stage_order,
          }),
        "tasks.insert"
      )
      if (tErr) {
        failedTasks.push({ title: taskDef.title, error: tErr })
      } else {
        createdTasks.push(taskDef.title)
      }
    }
  }

  // 8-pre. ACTION-REQUIRED stages (Phase C, 2026-07-02): stages registered in
  // lib/portal/action-stage-registry.ts require a CLIENT action on entry
  // (fill the tax wizard, print/sign/mail ITIN docs). For those, the shared
  // notifyClientActionRequired dispatch (clickable chat + immediate email +
  // bell/push) REPLACES the generic notification (8), the raw stage push (8a)
  // and the notify_client_email stage email (8b) — one message, never doubles.
  const { actionStageConfigFor } = await import("@/lib/portal/action-stage-registry")
  const actionStageCfg = actionStageConfigFor(delivery.service_type, targetStage.stage_name)
  if (!skip_notify && actionStageCfg && (delivery.account_id || delivery.contact_id)) {
    try {
      const { notifyClientActionRequired } = await import("@/lib/portal/action-required")
      const { buildFlowTopic, deriveFlowYear } = await import("@/lib/flows/resolve-flows")
      const topic = buildFlowTopic(delivery.service_type, deriveFlowYear(delivery)) || null
      const dispatch = await notifyClientActionRequired({
        contact_id: delivery.contact_id ?? null,
        account_id: delivery.account_id ?? null,
        service_delivery_id: delivery.id,
        topic,
        title: actionStageCfg.title,
        message: actionStageCfg.message,
        link: actionStageCfg.link.replace("{sd_id}", delivery.id),
      })
      autoTriggers.push(
        `Action-required dispatched (${targetStage.stage_name}): chat=${dispatch.chat}, email=${dispatch.email}, portal=${dispatch.notification}`,
      )
    } catch (actionErr) {
      autoTriggers.push(
        `Action-required dispatch failed: ${actionErr instanceof Error ? actionErr.message : String(actionErr)}`,
      )
    }
  }

  // 8. Portal notification for client. Accept either account-scoped SDs or
  // contact-only SDs (Phase 1 ITIN rule, 2026-05-11) so ITIN advances notify
  // the client too. Suppressed when skip_notify (bulk reconcile/backfill).
  // Skipped for action-required stages — 8-pre owns those.
  if (!skip_notify && !actionStageCfg && (delivery.account_id || delivery.contact_id)) {
    try {
      const { createPortalNotification } = await import("@/lib/portal/notifications")
      // Client-friendly stage label instead of the internal stage name
      // ("Sign your SS-4", not "SS-4 Prepared"). Localized to the SD's contact
      // when one is linked; account-scoped SDs without a contact fall back to
      // the English label. Internal name remains the last-resort fallback.
      const stageForLabel = targetStage as typeof targetStage & {
        client_label?: string | null
        client_label_it?: string | null
      }
      let stageLabel = stageForLabel.client_label || targetStage.stage_name
      if (stageForLabel.client_label_it && delivery.contact_id) {
        try {
          const { data: labelContact } = await supabaseAdmin
            .from("contacts")
            .select("language")
            .eq("id", delivery.contact_id)
            .maybeSingle()
          const { localeFromLanguage } = await import("@/lib/locale")
          if (localeFromLanguage(labelContact?.language) === "it") {
            stageLabel = stageForLabel.client_label_it
          }
        } catch {
          /* label localization is best-effort — keep the English/internal label */
        }
      }
      const title = isCompleted
        ? `${delivery.service_name || delivery.service_type} is complete!`
        : `${delivery.service_name || delivery.service_type} update`
      const body = isCompleted
        ? "Your service has been completed."
        : `Status updated to: ${stageLabel}`
      await createPortalNotification({
        account_id: delivery.account_id ?? undefined,
        contact_id: delivery.contact_id ?? undefined,
        type: "service",
        title,
        body,
        link: "/portal/services",
      })
      autoTriggers.push(`Portal notification sent: "${title}"`)
    } catch {
      // Non-critical — don't fail the advance
    }
  }

  // 8a. Phase 4 (2026-05-11) — explicit SD-stage-advance push notification.
  // Tagged with sd-advance-<delivery_id> so the OS stacks/replaces older pushes
  // for the same delivery instead of accumulating. Account-scoped SDs push to
  // the account; contact-only SDs (ITIN) push to the contact.
  // Suppressed when skip_notify (bulk reconcile/backfill).
  if (!skip_notify && !actionStageCfg && (delivery.account_id || delivery.contact_id)) {
    try {
      const { sendPushToAccount, sendPushToContact } = await import("@/lib/portal/web-push")
      const serviceLabel = delivery.service_name || delivery.service_type
      const pushPayload = {
        title: "Service Update",
        body: `${serviceLabel} moved to ${targetStage.stage_name}`,
        url: "/portal/services",
        tag: `sd-advance-${delivery_id}`,
      }
      if (delivery.account_id) {
        await sendPushToAccount(delivery.account_id, pushPayload)
      } else if (delivery.contact_id) {
        await sendPushToContact(delivery.contact_id, pushPayload)
      }
      autoTriggers.push(`SD-advance push dispatched (tag: ${pushPayload.tag})`)
    } catch (pushErr) {
      autoTriggers.push(`SD-advance push failed: ${pushErr instanceof Error ? pushErr.message : String(pushErr)}`)
    }
  }

  // 8b. Phase 4 (2026-05-11) — bilingual stage-change email, gated by
  // pipeline_stages.notify_client_email. Only fires for milestone stages
  // (Submitted to IRS, ITIN Approved, TR Filed, TR Completed,
  // Post-Formation + Banking, Closing) so we don't spam clients on every
  // internal hop. EN/IT chosen per contacts.language.
  //
  // The cast is here (not in database.types.ts) because the column is only
  // in sandbox until Antonio promotes the migration to production — the
  // pre-push schema-drift check regenerates types from production and would
  // strip the field otherwise. The cast collapses to the canonical row
  // shape once production is migrated and types refresh.
  const targetStageWithNotify = targetStage as typeof targetStage & {
    notify_client_email?: boolean | null
    client_notification_message?: string | null
  }
  if (!skip_notify && !actionStageCfg && targetStageWithNotify.notify_client_email && (delivery.account_id || delivery.contact_id)) {
    try {
      const { notifyClientOfStageAdvance } = await import("@/lib/portal/notifications")
      const result = await notifyClientOfStageAdvance({
        account_id: delivery.account_id ?? undefined,
        contact_id: delivery.contact_id ?? undefined,
        service_name: delivery.service_name || delivery.service_type,
        stage_name: targetStage.stage_name,
        custom_message: targetStageWithNotify.client_notification_message ?? null,
      })
      autoTriggers.push(`Stage-change email sent: ${result.sent} delivered, ${result.failed} failed`)
    } catch (emailErr) {
      autoTriggers.push(`Stage-change email failed: ${emailErr instanceof Error ? emailErr.message : String(emailErr)}`)
    }
  }

  // 8c (RETIRED 2026-07-02, Phase C): the bespoke ITIN "Document Preparation
  // → Client Signing" chat block moved to the shared action-stage rail — the
  // 'ITIN::Client Signing' entry in lib/portal/action-stage-registry.ts,
  // dispatched by 8-pre above (same copy, same SD-stamped chat threading,
  // plus bell/push and an immediate email replacing the R103-throttled one).

  // 9. Tax Return — sync tax_returns record with SD stage.
  // Canonical service_type is "Tax Return" (matches activate-service,
  // VALID_SERVICE_TYPES, and pipeline_stages). The old "Tax Return Filing"
  // guard never fired — fixed 2026-05-11 alongside Phase 1 ITIN.
  // Phase 3 (2026-05-11): skip the sync when the advance was triggered by
  // the tax-return tab — the tab already wrote tax_returns.status, syncing
  // back would overwrite the user's choice in a feedback loop.
  if (delivery.service_type === "Tax Return" && delivery.account_id && actor !== "tax-return-tab") {
    try {
      const taxYear = new Date().getFullYear()
      const { data: tr } = await supabaseAdmin
        .from("tax_returns")
        .select("id, status")
        .eq("account_id", delivery.account_id)
        .eq("tax_year", taxYear)
        .maybeSingle()

      if (tr) {
        const stageToStatus: Record<string, string> = {
          "Payment Verified": "Activated - Need Link",
          "Data Link Sent": "Link Sent - Awaiting Data",
          "Extension Requested": "Extension Requested",
          "Extension Filed": "Extension Filed",
          "Data Received": "Data Received",
          "Sent to be filed": "Sent to Accountant",
          "TR Completed": "TR Completed - Awaiting Signature",
          "TR Filed": "TR Filed",
        }
        const newStatus = stageToStatus[targetStage.stage_name]
        if (newStatus && newStatus !== tr.status) {
          const trUpdates: Record<string, unknown> = { status: newStatus, updated_at: new Date().toISOString() }

          if (targetStage.stage_name === "Extension Requested") {
            trUpdates.extension_requested_date = new Date().toISOString().slice(0, 10)
          } else if (targetStage.stage_name === "Extension Filed") {
            trUpdates.extension_filed = true
            trUpdates.extension_confirmed_date = new Date().toISOString().slice(0, 10)
          } else if (targetStage.stage_name === "Data Received") {
            trUpdates.data_received = true
            trUpdates.data_received_date = new Date().toISOString().slice(0, 10)
          } else if (targetStage.stage_name === "Sent to be filed") {
            trUpdates.sent_to_accountant = true
            trUpdates.sent_to_accountant_date = new Date().toISOString().slice(0, 10)
            trUpdates.accountant_status = "Sent - Pending"
          }

          await dbWriteSafe(
            supabaseAdmin.from("tax_returns").update(trUpdates).eq("id", tr.id),
            "tax_returns.update"
          )
          autoTriggers.push(`Tax return synced: ${tr.status} → ${newStatus}`)
        }
      }
    } catch (trErr) {
      autoTriggers.push(`Tax return sync failed: ${trErr instanceof Error ? trErr.message : String(trErr)}`)
    }
  }

  // 10. RA Renewal — update ra_renewal_date +1 year on completion
  if (delivery.service_type === "State RA Renewal" && isCompleted && delivery.account_id) {
    try {
      const { data: acct } = await supabaseAdmin
        .from("accounts")
        .select("ra_renewal_date")
        .eq("id", delivery.account_id)
        .single()

      if (acct?.ra_renewal_date) {
        const currentDate = new Date(acct.ra_renewal_date)
        currentDate.setFullYear(currentDate.getFullYear() + 1)
        const newDate = currentDate.toISOString().split("T")[0]

        await dbWriteSafe(
          // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
          supabaseAdmin
            .from("accounts")
            .update({ ra_renewal_date: newDate, updated_at: new Date().toISOString() })
            .eq("id", delivery.account_id),
          "accounts.update"
        )
        autoTriggers.push(`RA renewal date updated: ${acct.ra_renewal_date} → ${newDate}`)
      }

      // Close related open tasks
      const { data: openTasks } = await supabaseAdmin
        .from("tasks")
        .select("id")
        .eq("delivery_id", delivery_id)
        .in("status", ["To Do", "In Progress"])

      if (openTasks?.length) {
        const { updateTasksBulk } = await import("@/lib/operations/task")
        await updateTasksBulk({
          delivery_id,
          status_in: ["To Do", "In Progress"],
          patch: { status: "Done" },
          actor: "system:sd-ra-renewal-complete",
          summary: `Auto-closed ${openTasks.length} task(s) for RA Renewal completion`,
          account_id: delivery.account_id ?? undefined,
        })
        autoTriggers.push(`Closed ${openTasks.length} related task(s)`)
      }
    } catch (raErr) {
      autoTriggers.push(`RA renewal auto-update failed: ${raErr instanceof Error ? raErr.message : String(raErr)}`)
    }
  }

  // 11. Annual Report — update annual_report_due_date +1 year on completion
  if (delivery.service_type === "State Annual Report" && isCompleted && delivery.account_id) {
    try {
      const { data: acct } = await supabaseAdmin
        .from("accounts")
        .select("annual_report_due_date")
        .eq("id", delivery.account_id)
        .single()

      if (acct?.annual_report_due_date) {
        const currentDate = new Date(acct.annual_report_due_date)
        currentDate.setFullYear(currentDate.getFullYear() + 1)
        const newDate = currentDate.toISOString().split("T")[0]

        await dbWriteSafe(
          // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
          supabaseAdmin
            .from("accounts")
            .update({ annual_report_due_date: newDate, updated_at: new Date().toISOString() })
            .eq("id", delivery.account_id),
          "accounts.update"
        )
        autoTriggers.push(`Annual report due date updated: ${acct.annual_report_due_date} → ${newDate}`)
      }

      // Close related open tasks
      const { data: arTasks } = await supabaseAdmin
        .from("tasks")
        .select("id")
        .eq("delivery_id", delivery_id)
        .in("status", ["To Do", "In Progress"])

      if (arTasks?.length) {
        const { updateTasksBulk } = await import("@/lib/operations/task")
        await updateTasksBulk({
          delivery_id,
          status_in: ["To Do", "In Progress"],
          patch: { status: "Done" },
          actor: "system:sd-annual-report-complete",
          summary: `Auto-closed ${arTasks.length} task(s) for Annual Report completion`,
          account_id: delivery.account_id ?? undefined,
        })
        autoTriggers.push(`Closed ${arTasks.length} related task(s)`)
      }
    } catch (arErr) {
      autoTriggers.push(`Annual report auto-update failed: ${arErr instanceof Error ? arErr.message : String(arErr)}`)
    }
  }

  // 11b. Company Formation — MATERIALIZE the CRM account when advancing into
  // "Articles Received" for an in-flight (contact-scoped, account_id NULL)
  // formation. All the heavy lifting — account insert, owner/member links, Drive
  // folder, SD account_id link, portal-tier sync — lives in
  // materializeFormationCompany (the single account-creation path, shared with
  // the Upload Articles admin action + articles-detector cron). We DON'T
  // duplicate it; we just call it with the right params, bridging two v2 gaps:
  //   • the confirmed name lives in service_deliveries.name_checks (status
  //     'filed'), not wizard_progress.chosen_name_final → pass it as chosen_name;
  //   • materialize needs a state CODE → resolve from wizard data, default NM.
  // Resilient: a failure is logged to auto_triggers but never fails the advance
  // (the stage move already committed above). On success we reflect the new
  // account on the in-memory record so sections 12 & 13 below fire this run.
  let materialization: AdvanceStageResult["materialization"]
  if (
    delivery.service_type === "Company Formation" &&
    targetStage.stage_name === "Articles Received" &&
    !delivery.account_id &&
    delivery.contact_id
  ) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- name_checks not in generated types
      const { data: ncRow } = await (supabaseAdmin as any)
        .from("service_deliveries")
        .select("name_checks")
        .eq("id", delivery_id)
        .maybeSingle()
      // Name lockstep (bug-hunter 2026-07-28): pass the filed name when we have
      // one, otherwise let the materializer's OWN fallback chain run
      // (wizard_progress.chosen_name_final → chosen_name) — the same chain the
      // §4b preflight uses. The old hard-skip on a missing name_checks entry
      // let the gate pass on the wizard name and then silently skipped
      // materialization here.
      const confirmedName = filedName((ncRow?.name_checks as NameCheck[] | null) ?? null)
      {
        // Resolve the formation state CODE (WS-B, dev job c0a61e44) through the
        // full authority chain: the client's wizard answer → the formation-form
        // submission value → the SIGNED offer's pinned state → the documented
        // NM default. Before WS-B this site consulted only the wizard (which
        // rarely captures state) and silently defaulted a Wyoming deal to NM —
        // the exact cross-surface legal mismatch the offer field exists to fix.
        // All spelling/normalization lives in lib/formation/states.ts.
        const { data: wp } = await supabaseAdmin
          .from("wizard_progress")
          .select("data")
          .eq("contact_id", delivery.contact_id)
          .eq("wizard_type", "formation")
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle()
        const wd = (wp?.data ?? {}) as Record<string, unknown>
        const { data: subRow, error: subErr } = await supabaseAdmin
          .from("formation_submissions")
          .select("state")
          .eq("contact_id", delivery.contact_id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
        const offerState = await formationStateForClient({ contactId: delivery.contact_id })
        const stateResolution = resolveFormationStateCode({
          wizardState: formationStateFromWizardData(wd),
          submissionState: (subRow as { state?: string | null } | null)?.state,
          offerState,
        })
        const stateCode = stateResolution.code
        // A lookup failure must be VISIBLE, not silently identical to "no state
        // captured" — the fallback target is a legal filing state (adversarial
        // QA finding 5). The resolution SOURCE is recorded in auto_triggers so
        // staff can see which tier decided the state.
        if (subErr) {
          autoTriggers.push(`⚠ formation state: submission lookup failed (${subErr.message}) — resolved from ${stateResolution.source} (${stateCode})`)
          console.error(`[flow-advance] formation_submissions state lookup failed for contact ${delivery.contact_id}:`, subErr.message)
        }

        const { materializeFormationCompany } = await import("@/lib/operations/formation-materialize")
        const mat = await materializeFormationCompany({
          contact_id: delivery.contact_id,
          chosen_name: confirmedName ?? undefined,
          formation_state: stateCode,
          // Staff-confirmed filing date (OCR-prefilled in the workspace). When
          // omitted the materializer still falls back to today — but the
          // workspace requires it before this transition, so that's a safety net
          // for non-UI callers (cron/MCP), not the normal path.
          formation_date: params.formation_date,
          // Staff-supplied LLC-type override from the upload dialog — wins
          // over contract/form/wizard resolution (see AdvanceStageParams).
          entity_type: params.entity_type,
          actor: `flow-advance:${actor}`,
        })
        if (mat.success && mat.account_id) {
          delivery.account_id = mat.account_id
          autoTriggers.push(`Account materialized: ${confirmedName ?? "(name from wizard data)"} (${stateCode}, state from ${stateResolution.source}) → ${mat.account_id} [${mat.outcome}]`)
          materialization = { attempted: true, outcome: mat.outcome, account_id: mat.account_id }
        } else {
          autoTriggers.push(`Account materialization failed (${mat.outcome}): ${mat.error ?? "unknown"}`)
          materialization = {
            attempted: true,
            outcome: mat.outcome,
            error: `${mat.error ?? "unknown"} — the company record was NOT created.`,
          }
        }
      }
    } catch (matErr) {
      const msg = matErr instanceof Error ? matErr.message : String(matErr)
      autoTriggers.push(`Account materialization error: ${msg}`)
      materialization = {
        attempted: true,
        outcome: "error",
        error: `${msg} — the company record was NOT created.`,
      }
    }
  }

  // 12. Company Formation — set initial renewal dates when the company becomes
  // real. Fires on advance into "Articles Received" (the milestone where the
  // state-approved company exists and the CRM account is materialized) — moved
  // here from the old "Post-Formation + Banking"/"Closing" stages in the 7-stage
  // v2 pipeline (migration 20260617-formation-workspace-v2.sql).
  if (
    delivery.service_type === "Company Formation" &&
    targetStage.stage_name === "Articles Received" &&
    delivery.account_id
  ) {
    try {
      // Single source of truth for the initial fills (plan c2d97552 B1/B2):
      // lib/operations/renewal-dates.ts. Adds ra_renewal_date (formation
      // anniversary +1yr) which this site historically never set — the root
      // cause of formations invisible to the compliance calendar.
      const { data: acctDates } = await supabaseAdmin
        .from("accounts")
        .select("ra_renewal_date, cmra_renewal_date, annual_report_due_date, state_of_formation, formation_date")
        .eq("id", delivery.account_id)
        .single()

      if (acctDates) {
        const { deriveRenewalDates, applyRenewalDateFills } = await import("@/lib/operations/renewal-dates")
        const fills = deriveRenewalDates({
          intake: "formation",
          formation_date: acctDates.formation_date,
          state_of_formation: acctDates.state_of_formation,
          existing: {
            ra_renewal_date: acctDates.ra_renewal_date,
            annual_report_due_date: acctDates.annual_report_due_date,
            cmra_renewal_date: acctDates.cmra_renewal_date,
          },
        })
        const applied = await applyRenewalDateFills(delivery.account_id, fills, {
          state: acctDates.state_of_formation,
          actor: "articles-received",
        })
        if (applied.length) autoTriggers.push(`Renewal dates set: ${applied.join(", ")}`)
      }
    } catch (rdErr) {
      autoTriggers.push(`Renewal dates failed: ${rdErr instanceof Error ? rdErr.message : String(rdErr)}`)
    }
  }

  // 13. Welcome Package — enqueued when the company becomes real. Fires on
  // advance into "Articles Received" (moved from "Post-Formation + Banking" in
  // the 7-stage v2 pipeline). Idempotent: the handler dedupes via
  // accounts.welcome_package_status, and the EIN-received handlers re-enqueue it
  // (also idempotent) as a safety net.
  if (
    delivery.service_type === "Company Formation" &&
    targetStage.stage_name === "Articles Received" &&
    delivery.account_id
  ) {
    try {
      const { data: acctCheck } = await supabaseAdmin
        .from("accounts")
        .select("welcome_package_status")
        .eq("id", delivery.account_id)
        .single()

      if (acctCheck?.welcome_package_status) {
        autoTriggers.push(`Welcome package: already ${acctCheck.welcome_package_status}`)
      } else {
        const { enqueueJob } = await import("@/lib/jobs/queue")
        await enqueueJob({
          job_type: "welcome_package_prepare",
          payload: { account_id: delivery.account_id },
          priority: 5,
        })
        autoTriggers.push("Welcome package job enqueued")
      }
    } catch (wpErr) {
      autoTriggers.push(`Welcome package auto-trigger failed: ${wpErr instanceof Error ? wpErr.message : String(wpErr)}`)
    }
  }

  // 13b. Company Formation — best-effort SS-4 auto-generation when advancing into
  // "SS-4 Prepared". Reuses the shared createSS4 core. It often can't complete
  // yet (e.g. no Registered Agent set on the freshly materialized account, which
  // Line 6 requires) — that's expected and NOT an error: it's logged to
  // auto_triggers and staff click "Generate SS-4" in the workspace after setting
  // the RA. Never fails the advance (the stage move already committed above).
  if (
    delivery.service_type === "Company Formation" &&
    targetStage.stage_name === "SS-4 Prepared" &&
    delivery.account_id
  ) {
    try {
      const { createSS4 } = await import("@/lib/operations/ss4")
      const r = await createSS4({ account_id: delivery.account_id })
      if (r.ok) {
        autoTriggers.push(`SS-4 generated (${r.ss4?.status ?? "draft"})`)
      } else if (r.outcome === "already_exists") {
        autoTriggers.push("SS-4 already exists — left as-is")
      } else {
        autoTriggers.push(`SS-4 not auto-generated (${r.outcome}): ${r.message ?? ""}`.trim())
      }
    } catch (ssErr) {
      autoTriggers.push(`SS-4 auto-generation error: ${ssErr instanceof Error ? ssErr.message : String(ssErr)}`)
    }
  }

  // 14. Company Closure — cancel all active services, deactivate account
  if (
    delivery.service_type === "Company Closure" &&
    targetStage.stage_name === "Closing" &&
    delivery.account_id
  ) {
    try {
      const { data: activeSds } = await supabaseAdmin
        .from("service_deliveries")
        .select("id, service_type")
        .eq("account_id", delivery.account_id)
        .eq("status", "active")
        .neq("id", delivery_id)

      if (activeSds?.length) {
        for (const sd of activeSds) {
          await dbWriteSafe(
            // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
            supabaseAdmin
              .from("service_deliveries")
              .update({ status: "cancelled", updated_at: new Date().toISOString() })
              .eq("id", sd.id),
            "service_deliveries.update"
          )
        }
        autoTriggers.push(`Cancelled ${activeSds.length} active SDs: ${activeSds.map(s => s.service_type).join(", ")}`)
      }

      await dbWriteSafe(
        // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
        supabaseAdmin
          .from("accounts")
          .update({ status: "Closed" satisfies (typeof ACCOUNT_STATUS)[number], portal_account: false, updated_at: new Date().toISOString() })
          .eq("id", delivery.account_id),
        "accounts.update"
      )
      autoTriggers.push("Account → Closed, portal deactivated")

      const { data: openTasks } = await supabaseAdmin
        .from("tasks")
        .select("id")
        .eq("account_id", delivery.account_id)
        .in("status", ["To Do", "In Progress", "Waiting"])

      if (openTasks?.length) {
        const { updateTasksBulk } = await import("@/lib/operations/task")
        await updateTasksBulk({
          account_id: delivery.account_id,
          status_in: ["To Do", "In Progress", "Waiting"],
          patch: { status: "Done" },
          actor: "system:sd-closure",
          summary: `Auto-closed ${openTasks.length} open task(s) for account closure`,
        })
        autoTriggers.push(`Closed ${openTasks.length} open tasks`)
      }

      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
      await dbWriteSafe(supabaseAdmin.from("tasks").insert([
        {
          task_title: `[CLOSURE] Remove RA on Harbor Compliance`,
          description: `Company closure in progress. Remove Registered Agent service from Harbor Compliance portal.`,
          assigned_to: "Luca", priority: "High", category: "Filing", status: "To Do",
          account_id: delivery.account_id, delivery_id, created_by: "System",
        },
        {
          task_title: `[CLOSURE] Cancel QB recurring invoices`,
          description: `Company closure. Check QuickBooks for any recurring invoices and cancel them.`,
          assigned_to: "Luca", priority: "Normal", category: "Payment", status: "To Do",
          account_id: delivery.account_id, delivery_id, created_by: "System",
        },
        {
          task_title: `[CLOSURE] Email client -- closure complete`,
          description: `All closure steps done. Send confirmation email to client that their LLC has been dissolved.`,
          assigned_to: "Luca", priority: "Normal", category: "Client Communication", status: "To Do",
          account_id: delivery.account_id, delivery_id, created_by: "System",
        },
      ]), "tasks.insert")
      autoTriggers.push("Created 3 closure tasks: Harbor RA, QB invoices, client email")
    } catch (closureErr) {
      autoTriggers.push(`Closure auto-cleanup failed: ${closureErr instanceof Error ? closureErr.message : String(closureErr)}`)
    }
  }

  // 15. Action log
  logAction({
    action_type: "advance",
    table_name: "service_deliveries",
    record_id: delivery_id,
    account_id: delivery.account_id || undefined,
    summary: `Stage advanced: ${delivery.stage || "New"} → ${targetStage.stage_name} (${delivery.service_name || delivery.service_type}) [${actor}]`,
    details: { from_stage: delivery.stage, to_stage: targetStage.stage_name, tasks_created: createdTasks, notes, actor },
  })

  return {
    success: true,
    from_stage: delivery.stage || "New",
    to_stage: targetStage.stage_name,
    to_order: targetStage.stage_order,
    total_stages: stages.length,
    is_completed: isCompleted,
    created_tasks: createdTasks,
    failed_tasks: failedTasks,
    auto_triggers: autoTriggers,
    requires_approval: targetStage.requires_approval ?? false,
    sla_days: targetStage.sla_days ?? null,
    materialization,
  }
}
