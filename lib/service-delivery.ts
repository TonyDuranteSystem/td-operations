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
 *   8. Company Formation renewal date initialization
 *   9. Welcome package enqueue on Post-Formation
 *   10. Company Closure cascade (cancel SDs, deactivate account/portal, closure tasks)
 *   11. Action log entry
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { dbWrite, dbWriteSafe } from "@/lib/db"
import { logAction } from "@/lib/mcp/action-log"
import { ACCOUNT_STATUS } from "@/lib/constants"

// ─── Types ────────────────────────────────────────────────

export interface AdvanceStageParams {
  delivery_id: string
  target_stage?: string
  skip_tasks?: boolean
  notes?: string
  actor?: string // "crm-tracker" | "mcp" | etc.
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
}

// ─── Main function ────────────────────────────────────────

export async function advanceServiceDelivery(
  params: AdvanceStageParams,
): Promise<AdvanceStageResult> {
  const { delivery_id, target_stage, skip_tasks = false, notes, actor = "system" } = params

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
  const isCompleted = targetStage.stage_name === "Completed" || targetStage.stage_name === "TR Filed"
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
            account_id: delivery.account_id,
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

  const autoTriggers: string[] = []

  // 7b. Portal tier upgrade: active → full
  if (delivery.account_id) {
    const shouldUpgradeToFull = isCompleted
      || targetStage.stage_name === "EIN Received"
      || targetStage.stage_name === "Welcome Package"
      || targetStage.stage_order >= 8

    if (shouldUpgradeToFull) {
      const { data: acct } = await supabaseAdmin
        .from("accounts")
        .select("portal_tier")
        .eq("id", delivery.account_id)
        .single()

      if (acct?.portal_tier === "active") {
        await dbWriteSafe(
          // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
          supabaseAdmin
            .from("accounts")
            .update({ portal_tier: "full", updated_at: new Date().toISOString() })
            .eq("id", delivery.account_id),
          "accounts.update"
        )
        autoTriggers.push("Portal tier upgraded: active → full")
      }
    }
  }

  // 8. Portal notification for client
  if (delivery.account_id) {
    try {
      const { createPortalNotification } = await import("@/lib/portal/notifications")
      const title = isCompleted
        ? `${delivery.service_name || delivery.service_type} is complete!`
        : `${delivery.service_name || delivery.service_type} update`
      const body = isCompleted
        ? "Your service has been completed."
        : `Status updated to: ${targetStage.stage_name}`
      await createPortalNotification({
        account_id: delivery.account_id,
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

  // 9. Tax Return — sync tax_returns record with SD stage
  if (delivery.service_type === "Tax Return Filing" && delivery.account_id) {
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
          "Preparation - Sent to India": "Sent to India",
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
          } else if (targetStage.stage_name === "Preparation - Sent to India") {
            trUpdates.sent_to_india = true
            trUpdates.sent_to_india_date = new Date().toISOString().slice(0, 10)
            trUpdates.india_status = "Sent - Pending"
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

  // 12. Company Formation — set initial renewal dates on closing stages
  if (
    delivery.service_type === "Company Formation" &&
    (targetStage.stage_name === "Post-Formation + Banking" || targetStage.stage_name === "Closing") &&
    delivery.account_id
  ) {
    try {
      const { data: acctDates } = await supabaseAdmin
        .from("accounts")
        .select("cmra_renewal_date, annual_report_due_date, state_of_formation, formation_date")
        .eq("id", delivery.account_id)
        .single()

      if (acctDates) {
        const renewals: Record<string, unknown> = {}
        const currentYear = new Date().getFullYear()

        if (!acctDates.cmra_renewal_date) {
          renewals.cmra_renewal_date = `${currentYear}-12-31`
        }
        if (!acctDates.annual_report_due_date) {
          const st = (acctDates.state_of_formation || "").toUpperCase()
            .replace("NEW MEXICO", "NM").replace("WYOMING", "WY")
            .replace("FLORIDA", "FL").replace("DELAWARE", "DE")

          if (st === "FL") renewals.annual_report_due_date = `${currentYear + 1}-05-01`
          else if (st === "DE") renewals.annual_report_due_date = `${currentYear + 1}-06-01`
          else if (st === "WY" && acctDates.formation_date) {
            const month = String(acctDates.formation_date).slice(5, 7)
            renewals.annual_report_due_date = `${currentYear + 1}-${month}-01`
          }
        }
        if (Object.keys(renewals).length > 0) {
          renewals.updated_at = new Date().toISOString()
          await dbWriteSafe(
            // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
            supabaseAdmin.from("accounts").update(renewals).eq("id", delivery.account_id),
            "accounts.update"
          )
          const datesList = Object.entries(renewals)
            .filter(([k]) => k !== "updated_at")
            .map(([k, v]) => `${k}=${v}`).join(", ")
          autoTriggers.push(`Renewal dates set: ${datesList}`)
        }
      }
    } catch (rdErr) {
      autoTriggers.push(`Renewal dates failed: ${rdErr instanceof Error ? rdErr.message : String(rdErr)}`)
    }
  }

  // 13. Welcome Package on "Post-Formation + Banking"
  if (
    delivery.service_type === "Company Formation" &&
    targetStage.stage_name === "Post-Formation + Banking" &&
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
  }
}
