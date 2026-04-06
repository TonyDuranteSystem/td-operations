/**
 * Contact Quick Actions API
 *
 * POST { contact_id, action, params }
 *
 * Actions:
 *   wizard_reminder    — Send wizard reminder notification (3-day dedup)
 *   advance_stage      — Advance a service delivery stage (full auto-chain)
 *   select_llc_name    — Choose one of 3 wizard name options as the official LLC name
 *   mark_fax_sent      — Mark SS-4 fax as sent to IRS + advance pipeline to EIN Submitted
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { createPortalNotification } from "@/lib/portal/notifications"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { contact_id, action, params } = body

    if (!contact_id || !action) {
      return NextResponse.json({ error: "Missing contact_id or action" }, { status: 400 })
    }

    let result: { success: boolean; detail: string; side_effects?: string[] }

    switch (action) {
      // ─── WIZARD REMINDER (with 3-day dedup) ───
      case "wizard_reminder": {
        // Check for recent reminder (dedup: 3 days)
        const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
        const { data: recentNotifs } = await supabaseAdmin
          .from("portal_notifications")
          .select("id, created_at")
          .eq("contact_id", contact_id)
          .ilike("title", "%wizard%")
          .gte("created_at", threeDaysAgo)
          .limit(1)

        if (recentNotifs && recentNotifs.length > 0) {
          const sentDate = recentNotifs[0].created_at.split("T")[0]
          result = {
            success: false,
            detail: `Wizard reminder already sent on ${sentDate} (3-day dedup). Skipping.`,
          }
          break
        }

        // Get contact info for personalized notification
        const { data: contact } = await supabaseAdmin
          .from("contacts")
          .select("full_name, email")
          .eq("id", contact_id)
          .single()

        // Get linked account for the notification
        const { data: accountLinks } = await supabaseAdmin
          .from("account_contacts")
          .select("account_id")
          .eq("contact_id", contact_id)
          .limit(1)

        const accountId = accountLinks?.[0]?.account_id ?? null

        await createPortalNotification({
          contact_id,
          account_id: accountId ?? undefined,
          type: "wizard_reminder",
          title: "Complete your setup wizard",
          body: `Hi ${contact?.full_name?.split(" ")[0] ?? "there"}, please complete your data collection wizard so we can proceed with your services.`,
          link: "/portal/wizard",
        })

        result = {
          success: true,
          detail: `Wizard reminder sent to ${contact?.full_name ?? "contact"} via push notification + email digest`,
          side_effects: [
            "Portal notification created",
            "Web Push sent (if subscribed)",
            "Email digest will include this within 5 minutes",
          ],
        }
        break
      }

      // ─── ADVANCE STAGE (full auto-chain — mirrors sd_advance_stage MCP tool) ───
      case "advance_stage": {
        const deliveryId = params?.delivery_id as string
        const targetStageName = params?.target_stage as string | undefined
        const notes = params?.notes as string | undefined

        if (!deliveryId) {
          result = { success: false, detail: "Missing delivery_id" }
          break
        }

        // 1. Get current delivery
        const { data: delivery, error: dErr } = await supabaseAdmin
          .from("service_deliveries")
          .select("*")
          .eq("id", deliveryId)
          .single()
        if (dErr || !delivery) {
          result = { success: false, detail: "Service delivery not found" }
          break
        }

        // 2. Get pipeline stages
        const { data: stages, error: sErr } = await supabaseAdmin
          .from("pipeline_stages")
          .select("*")
          .eq("service_type", delivery.service_type)
          .order("stage_order")
        if (sErr || !stages?.length) {
          result = { success: false, detail: `No pipeline stages for ${delivery.service_type}` }
          break
        }

        // 3. Determine target stage
        const currentOrder = delivery.stage_order || 0
        let targetStage: typeof stages[0]

        if (targetStageName) {
          const found = stages.find((s: { stage_name: string }) => s.stage_name.toLowerCase() === targetStageName.toLowerCase())
          if (!found) {
            result = { success: false, detail: `Stage "${targetStageName}" not found. Available: ${stages.map((s: { stage_name: string }) => s.stage_name).join(", ")}` }
            break
          }
          targetStage = found
        } else {
          const nextStage = stages.find((s: { stage_order: number }) => s.stage_order > currentOrder)
          if (!nextStage) {
            result = { success: false, detail: "Already at final stage" }
            break
          }
          targetStage = nextStage
        }

        // 4. Build stage history
        const historyEntry = {
          from_stage: delivery.stage || "New",
          from_order: currentOrder,
          to_stage: targetStage.stage_name,
          to_order: targetStage.stage_order,
          advanced_at: new Date().toISOString(),
          advanced_by: "crm-admin",
          notes: notes || null,
        }
        const stageHistory = Array.isArray(delivery.stage_history)
          ? [...delivery.stage_history, historyEntry]
          : [historyEntry]

        // 5. Update delivery
        const isCompleted = targetStage.stage_name === "Completed" || targetStage.stage_name === "TR Filed"
        const { error: uErr } = await supabaseAdmin
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
          .eq("id", deliveryId)
        if (uErr) {
          result = { success: false, detail: `Update failed: ${uErr.message}` }
          break
        }

        const sideEffects: string[] = [
          `Stage: ${delivery.stage || "New"} → ${targetStage.stage_name}`,
        ]

        // 6. Auto-create tasks
        if (targetStage.auto_tasks && Array.isArray(targetStage.auto_tasks)) {
          let created = 0
          for (const taskDef of targetStage.auto_tasks as Array<{ title: string; assigned_to: string; category: string; priority: string; description?: string }>) {
            const { error: tErr } = await supabaseAdmin
              .from("tasks")
              .insert({
                task_title: `[${delivery.service_name || delivery.service_type}] ${taskDef.title}`,
                assigned_to: taskDef.assigned_to || "Luca",
                category: taskDef.category || "Internal",
                priority: taskDef.priority || "Normal",
                description: taskDef.description || `Auto-created by pipeline advance to "${targetStage.stage_name}"`,
                status: "To Do",
                account_id: delivery.account_id,
                deal_id: delivery.deal_id,
                delivery_id: delivery.id,
                stage_order: targetStage.stage_order,
              })
            if (!tErr) created++
          }
          if (created > 0) sideEffects.push(`${created} auto-tasks created`)
        }

        // 7. Portal tier upgrade check
        if (delivery.account_id) {
          const shouldUpgrade = isCompleted
            || targetStage.stage_name === "EIN Received"
            || targetStage.stage_name === "Welcome Package"
            || targetStage.stage_order >= 8

          if (shouldUpgrade) {
            const { data: acct } = await supabaseAdmin
              .from("accounts")
              .select("portal_tier")
              .eq("id", delivery.account_id)
              .single()

            if (acct?.portal_tier === "active") {
              await supabaseAdmin
                .from("accounts")
                .update({ portal_tier: "full", updated_at: new Date().toISOString() })
                .eq("id", delivery.account_id)
              sideEffects.push("Portal tier upgraded: active → full")
            }
          }
        }

        // 8. Portal notification to client
        if (delivery.account_id) {
          const title = isCompleted
            ? `${delivery.service_name || delivery.service_type} is complete!`
            : `${delivery.service_name || delivery.service_type} update`
          const notifBody = isCompleted
            ? "Your service has been completed."
            : `Status updated to: ${targetStage.stage_name}`
          createPortalNotification({
            account_id: delivery.account_id,
            type: "service",
            title,
            body: notifBody,
            link: "/portal/services",
          }).catch(() => {})
          sideEffects.push("Client notified via portal")
        }

        // 9. Tax Return sync
        if (delivery.service_type === "Tax Return Filing" && delivery.account_id) {
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
          const taxStatus = stageToStatus[targetStage.stage_name]
          if (taxStatus) {
            const taxYear = new Date().getFullYear()
            await supabaseAdmin
              .from("tax_returns")
              .update({ status: taxStatus, updated_at: new Date().toISOString() })
              .eq("account_id", delivery.account_id)
              .eq("tax_year", taxYear)
            sideEffects.push(`Tax return synced: ${taxStatus}`)
          }
        }

        if (isCompleted) sideEffects.push("Service delivery marked COMPLETED")

        // Log action
        await supabaseAdmin.from("action_log").insert({
          actor: "crm-admin",
          action_type: "advance_stage",
          table_name: "service_deliveries",
          record_id: deliveryId,
          account_id: delivery.account_id || undefined,
          summary: `Stage advanced: ${delivery.stage || "New"} → ${targetStage.stage_name} (${delivery.service_name || delivery.service_type})`,
          details: { from_stage: delivery.stage, to_stage: targetStage.stage_name, notes, side_effects: sideEffects },
        })

        result = {
          success: true,
          detail: `Advanced to ${targetStage.stage_name}`,
          side_effects: sideEffects,
        }
        break
      }

      // ─── SELECT LLC NAME (choose from 3 wizard options) ───
      case "select_llc_name": {
        const selectedName = (params?.selected_name as string ?? "").trim()
        const wizardProgressId = params?.wizard_progress_id as string

        if (!selectedName || !wizardProgressId) {
          result = { success: false, detail: "Missing selected_name or wizard_progress_id" }
          break
        }

        // Validate wizard progress
        const { data: wp, error: wpErr } = await supabaseAdmin
          .from("wizard_progress")
          .select("id, data, wizard_type, status, contact_id")
          .eq("id", wizardProgressId)
          .single()
        if (wpErr || !wp) {
          result = { success: false, detail: "Wizard progress record not found" }
          break
        }
        if (wp.wizard_type !== "formation") {
          result = { success: false, detail: "Wizard is not a formation type" }
          break
        }

        const sideEffects: string[] = []
        const wizardData = (wp.data || {}) as Record<string, unknown>
        const state = (wizardData.owner_state_province as string) || "NM"
        const entityType = wizardData.entity_type === "MMLLC" ? "Multi Member LLC" : "Single Member LLC"

        // Check if contact already has a linked account
        const { data: existingLinks } = await supabaseAdmin
          .from("account_contacts")
          .select("account_id, accounts:account_id(id, company_name, status)")
          .eq("contact_id", contact_id)

        let accountId: string | null = null

        if (existingLinks && existingLinks.length > 0) {
          // Update existing account
          const acct = existingLinks[0].accounts as unknown as { id: string; company_name: string } | null
          if (acct) {
            accountId = acct.id
            await supabaseAdmin
              .from("accounts")
              .update({
                company_name: `${selectedName} LLC`,
                updated_at: new Date().toISOString(),
              })
              .eq("id", accountId)
            sideEffects.push(`Account updated: ${acct.company_name} → ${selectedName} LLC`)
          }
        } else {
          // Create new account
          const { data: newAccount, error: aErr } = await supabaseAdmin
            .from("accounts")
            .insert({
              company_name: `${selectedName} LLC`,
              entity_type: entityType,
              state_of_formation: state === "NM" ? "New Mexico" : state === "WY" ? "Wyoming" : state === "DE" ? "Delaware" : state === "FL" ? "Florida" : state,
              status: "Active",
              account_type: "Client",
            })
            .select("id")
            .single()

          if (aErr || !newAccount) {
            result = { success: false, detail: `Failed to create account: ${aErr?.message}` }
            break
          }
          accountId = newAccount.id

          // Link contact to account
          await supabaseAdmin
            .from("account_contacts")
            .insert({
              account_id: accountId,
              contact_id: contact_id,
              role: "Owner",
            })
          sideEffects.push(`Account created: ${selectedName} LLC`)
          sideEffects.push("Contact linked to account as Owner")
        }

        // Update wizard_progress.data with chosen_name
        await supabaseAdmin
          .from("wizard_progress")
          .update({
            data: { ...wizardData, chosen_name: selectedName },
            updated_at: new Date().toISOString(),
          })
          .eq("id", wizardProgressId)
        sideEffects.push(`Wizard data updated with chosen_name: ${selectedName}`)

        // Update active Company Formation SD service_name if exists
        if (accountId) {
          const { data: updatedSds } = await supabaseAdmin
            .from("service_deliveries")
            .update({
              service_name: `Company Formation - ${selectedName} LLC`,
              updated_at: new Date().toISOString(),
            })
            .eq("account_id", accountId)
            .eq("service_type", "Company Formation")
            .eq("status", "active")
            .select("id")

          if (updatedSds && updatedSds.length > 0) {
            sideEffects.push("Service delivery name updated")
          }
        }

        // Log
        await supabaseAdmin.from("action_log").insert({
          actor: "crm-admin",
          action_type: "select_llc_name",
          table_name: "accounts",
          record_id: accountId,
          account_id: accountId,
          summary: `LLC name selected: ${selectedName} LLC (from 3 wizard choices)`,
          details: {
            selected_name: selectedName,
            wizard_progress_id: wizardProgressId,
            all_names: [wizardData.llc_name_1, wizardData.llc_name_2, wizardData.llc_name_3].filter(Boolean),
          },
        })

        result = {
          success: true,
          detail: `LLC name set to "${selectedName} LLC"`,
          side_effects: sideEffects,
        }
        break
      }

      // ─── MARK FAX SENT (SS-4 → IRS) ───
      case "mark_fax_sent": {
        const ss4Id = params?.ss4_id as string
        if (!ss4Id) {
          result = { success: false, detail: "Missing ss4_id" }
          break
        }

        const { markFaxAsSent } = await import("@/lib/pipeline-utils")
        result = await markFaxAsSent(ss4Id, "crm-admin", params?.notes as string | undefined)
        break
      }

      default:
        result = { success: false, detail: `Unknown action: ${action}` }
    }

    return NextResponse.json(result)
  } catch (e) {
    console.error("[contact-actions] Error:", e)
    return NextResponse.json({ success: false, detail: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
