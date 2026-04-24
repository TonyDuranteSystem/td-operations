/**
 * Contact Quick Actions API
 *
 * POST { contact_id, action, params }
 *
 * Actions:
 *   wizard_reminder    — Send wizard reminder notification (3-day dedup)
 *   advance_stage      — Advance a service delivery stage (full auto-chain)
 *   add_llc_name       — Append an admin-typed name candidate to the formation pool (verbatim, no LLC auto-append)
 *   remove_llc_name    — Remove an admin-added name candidate (wizard 3 are not removable)
 *   select_llc_name    — Pick a name (from wizard 3 OR admin-added) as the official LLC name; triggers account create/rename + Drive folder + SD rename + audit
 *   mark_fax_sent      — Mark SS-4 fax as sent to IRS + advance pipeline to EIN Submitted
 *   enter_ein          — Set EIN on account + advance pipeline to Post-Formation
 *   process_documents  — Re-run Drive folder creation + passport processing for a contact
 *   cancel_service     — Cancel a service delivery (set status to cancelled)
 *   ocr_document       — Run OCR on an existing document (passport→MRZ, ITIN→number extraction)
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { upgradePortalTier } from "@/lib/portal/auto-create"
import { createPortalNotification } from "@/lib/portal/notifications"
import { parseItinIssueDateFromOcr } from "@/lib/ocr-helpers"
import type { Json } from "@/lib/database.types"
import {
  type AdminAddedName,
  classifyNameSource,
  companyNameForAccount,
  isDuplicateName,
  validateAdminAddedName,
} from "@/lib/llc-name-helpers"

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
        // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
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
            // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
            const { error: tErr } = await supabaseAdmin
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
              // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
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
              .update({ status: taxStatus as never, updated_at: new Date().toISOString() })
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

      // ─── ADD LLC NAME (admin-added candidate, stored verbatim) ───
      case "add_llc_name": {
        const rawName = (params?.name as string) ?? ""
        const wizardProgressId = params?.wizard_progress_id as string
        if (!wizardProgressId) {
          result = { success: false, detail: "Missing wizard_progress_id" }
          break
        }
        const validation = validateAdminAddedName(rawName)
        if (!validation.valid || !validation.trimmed) {
          result = { success: false, detail: validation.error || "Invalid name" }
          break
        }
        const newName = validation.trimmed

        const { data: wp, error: wpErr } = await supabaseAdmin
          .from("wizard_progress")
          .select("id, data, wizard_type")
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

        const wd = (wp.data || {}) as Record<string, unknown>
        const existing: AdminAddedName[] = Array.isArray(wd.additional_names)
          ? (wd.additional_names as AdminAddedName[])
          : []
        const allCurrent = [
          (wd.llc_name_1 as string) || "",
          (wd.llc_name_2 as string) || "",
          (wd.llc_name_3 as string) || "",
          ...existing.map((e) => e.name),
        ]
        if (isDuplicateName(newName, allCurrent)) {
          result = { success: false, detail: "That name is already in the list." }
          break
        }

        const nowIso = new Date().toISOString()
        const updatedAdditional: AdminAddedName[] = [
          ...existing,
          { name: newName, added_at: nowIso, added_by: "crm-admin" },
        ]

        await supabaseAdmin
          .from("wizard_progress")
          .update({
            data: { ...wd, additional_names: updatedAdditional } as unknown as Json,
            updated_at: nowIso,
          })
          .eq("id", wizardProgressId)

        await supabaseAdmin.from("action_log").insert({
          actor: "crm-admin",
          action_type: "add_llc_name",
          table_name: "wizard_progress",
          record_id: wizardProgressId,
          summary: `LLC name candidate added: "${newName}"`,
          details: { name: newName, wizard_progress_id: wizardProgressId } as unknown as Json,
        })

        result = { success: true, detail: `Added "${newName}" to the name list.` }
        break
      }

      // ─── REMOVE LLC NAME (admin-added only — wizard 3 are not removable) ───
      case "remove_llc_name": {
        const rawName = (params?.name as string) ?? ""
        const wizardProgressId = params?.wizard_progress_id as string
        if (!wizardProgressId || !rawName.trim()) {
          result = { success: false, detail: "Missing wizard_progress_id or name" }
          break
        }
        const toRemove = rawName.trim()

        const { data: wp, error: wpErr } = await supabaseAdmin
          .from("wizard_progress")
          .select("id, data, wizard_type")
          .eq("id", wizardProgressId)
          .single()
        if (wpErr || !wp) {
          result = { success: false, detail: "Wizard progress record not found" }
          break
        }

        const wd = (wp.data || {}) as Record<string, unknown>
        const existing: AdminAddedName[] = Array.isArray(wd.additional_names)
          ? (wd.additional_names as AdminAddedName[])
          : []
        const filtered = existing.filter((e) => e.name !== toRemove)
        if (filtered.length === existing.length) {
          result = { success: false, detail: "Name not found in the admin-added list." }
          break
        }

        await supabaseAdmin
          .from("wizard_progress")
          .update({
            data: { ...wd, additional_names: filtered } as unknown as Json,
            updated_at: new Date().toISOString(),
          })
          .eq("id", wizardProgressId)

        await supabaseAdmin.from("action_log").insert({
          actor: "crm-admin",
          action_type: "remove_llc_name",
          table_name: "wizard_progress",
          record_id: wizardProgressId,
          summary: `LLC name candidate removed: "${toRemove}"`,
          details: { name: toRemove, wizard_progress_id: wizardProgressId } as unknown as Json,
        })

        result = { success: true, detail: `Removed "${toRemove}".` }
        break
      }

      // ─── SELECT LLC NAME (pick from wizard 3 + admin-added; triggers the activation pipeline) ───
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

        // Classify the source: wizard-original names get legacy " LLC" auto-append
        // (backward compat with inconsistent client input); admin-added names
        // are stored VERBATIM per R-discussion 2026-04-22 with Antonio.
        const additionalNamesRaw: AdminAddedName[] = Array.isArray(wizardData.additional_names)
          ? (wizardData.additional_names as AdminAddedName[])
          : []
        const nameSource = classifyNameSource(
          selectedName,
          {
            name1: wizardData.llc_name_1 as string | undefined,
            name2: wizardData.llc_name_2 as string | undefined,
            name3: wizardData.llc_name_3 as string | undefined,
          },
          additionalNamesRaw,
        )
        const finalCompanyName = companyNameForAccount(selectedName, nameSource)

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
            // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
            await supabaseAdmin
              .from("accounts")
              .update({
                company_name: finalCompanyName,
                updated_at: new Date().toISOString(),
              })
              .eq("id", accountId)
            sideEffects.push(`Account updated: ${acct.company_name} → ${finalCompanyName}`)
          }
        } else {
          // Create new account
          // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
          const { data: newAccount, error: aErr } = await supabaseAdmin
            .from("accounts")
            .insert({
              company_name: finalCompanyName,
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
          sideEffects.push(`Account created: ${finalCompanyName}`)
          sideEffects.push("Contact linked to account as Owner")
        }

        // Update wizard_progress.data with chosen_name (verbatim selection — preserved
        // for audit, matches what admin actually picked regardless of source).
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
          // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
          const { data: updatedSds } = await supabaseAdmin
            .from("service_deliveries")
            .update({
              service_name: `Company Formation - ${finalCompanyName}`,
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

        // Create company Drive folder + migrate files from contact folder
        if (accountId) {
          try {
            const { ensureCompanyFolder, migrateContactToCompany } = await import("@/lib/drive-folder-utils")

            // Get owner name for folder naming
            const { data: ownerContact } = await supabaseAdmin
              .from("contacts")
              .select("first_name, last_name, gdrive_folder_url")
              .eq("id", contact_id)
              .single()
            const ownerName = ownerContact
              ? [ownerContact.first_name, ownerContact.last_name].filter(Boolean).join(" ")
              : ""

            const stateForFolder = state === "NM" ? "New Mexico" : state === "WY" ? "Wyoming" : state === "DE" ? "Delaware" : state === "FL" ? "Florida" : state

            const companyResult = await ensureCompanyFolder(
              accountId,
              finalCompanyName,
              stateForFolder,
              ownerName,
            )

            if (companyResult.created) {
              sideEffects.push(`Company Drive folder created`)

              // Migrate files from contact folder if it exists
              if (ownerContact?.gdrive_folder_url) {
                const contactFolderMatch = (ownerContact.gdrive_folder_url as string).match(/folders\/([a-zA-Z0-9_-]+)/)
                if (contactFolderMatch) {
                  const migrationResult = await migrateContactToCompany(contactFolderMatch[1], companyResult.folderId, contact_id)
                  if (migrationResult.moved > 0) {
                    sideEffects.push(`${migrationResult.moved} file(s) migrated from contact folder`)
                  }
                  if (migrationResult.errors.length > 0) {
                    sideEffects.push(`Migration warnings: ${migrationResult.errors.length}`)
                  }
                }
              }
            } else {
              sideEffects.push("Company Drive folder already exists")
            }
          } catch (driveErr) {
            sideEffects.push(`Drive folder error: ${driveErr instanceof Error ? driveErr.message : String(driveErr)}`)
          }
        }

        // Log — includes source classification + full candidate pool for audit
        await supabaseAdmin.from("action_log").insert({
          actor: "crm-admin",
          action_type: "select_llc_name",
          table_name: "accounts",
          record_id: accountId,
          account_id: accountId,
          summary: `LLC name selected: ${finalCompanyName} (source: ${nameSource})`,
          details: {
            selected_name: selectedName,
            final_company_name: finalCompanyName,
            source: nameSource,
            wizard_progress_id: wizardProgressId,
            all_names: [
              wizardData.llc_name_1,
              wizardData.llc_name_2,
              wizardData.llc_name_3,
              ...additionalNamesRaw.map((a) => a.name),
            ].filter(Boolean),
          } as unknown as Json,
        })

        result = {
          success: true,
          detail: `LLC name set to "${finalCompanyName}"`,
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

      // ─── ENTER EIN (received from IRS → update account + advance pipeline) ───
      case "enter_ein": {
        const einNumber = (params?.ein_number as string ?? "").trim()
        const accountId = params?.account_id as string

        if (!einNumber || !accountId) {
          result = { success: false, detail: "Missing ein_number or account_id" }
          break
        }

        // Validate EIN format (XX-XXXXXXX)
        const einClean = einNumber.replace(/[^0-9-]/g, "")
        if (!/^\d{2}-?\d{7}$/.test(einClean)) {
          result = { success: false, detail: `Invalid EIN format: "${einNumber}". Expected: XX-XXXXXXX` }
          break
        }
        const einFormatted = einClean.includes("-") ? einClean : `${einClean.slice(0, 2)}-${einClean.slice(2)}`

        const einSideEffects: string[] = []

        // 1. Update account with EIN
        // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
        const { error: einErr } = await supabaseAdmin
          .from("accounts")
          .update({ ein_number: einFormatted, updated_at: new Date().toISOString() })
          .eq("id", accountId)
        if (einErr) {
          result = { success: false, detail: `Failed to update account: ${einErr.message}` }
          break
        }
        einSideEffects.push(`Account EIN set to ${einFormatted}`)

        // 2. Update SS-4 status to done (if exists)
        await supabaseAdmin
          .from("ss4_applications")
          .update({ status: "done", updated_at: new Date().toISOString() })
          .eq("account_id", accountId)
          .in("status", ["signed", "submitted"])
        einSideEffects.push("SS-4 status → done")

        // 3. Advance Company Formation pipeline to Post-Formation + Banking
        const { data: formationSds } = await supabaseAdmin
          .from("service_deliveries")
          .select("id")
          .eq("account_id", accountId)
          .eq("service_type", "Company Formation")
          .eq("status", "active")
          .limit(1)

        if (formationSds && formationSds.length > 0) {
          // Advance pipeline using shared utility
          const { advanceFormationToStage } = await import("@/lib/pipeline-utils")
          const advResult = await advanceFormationToStage(
            formationSds[0].id,
            "Post-Formation + Banking",
            "crm-admin",
            `EIN received: ${einFormatted}`,
          )
          if (advResult.advanced) {
            einSideEffects.push("Pipeline advanced to Post-Formation + Banking")
            einSideEffects.push(...advResult.sideEffects)
          } else {
            einSideEffects.push(`Pipeline advance: ${advResult.detail}`)
          }
        }

        // 4. Sync portal tier to active across contact + account + auth
        const tierResult = await upgradePortalTier(accountId, "active")
        einSideEffects.push(`Portal tier → active (prev: ${tierResult.previousTier ?? "unknown"}, success: ${tierResult.success})`)

        // 5. Log
        await supabaseAdmin.from("action_log").insert({
          actor: "crm-admin",
          action_type: "enter_ein",
          table_name: "accounts",
          record_id: accountId,
          account_id: accountId,
          summary: `EIN entered: ${einFormatted}`,
          details: { ein_number: einFormatted },
        })

        result = {
          success: true,
          detail: `EIN ${einFormatted} saved. Pipeline advancing to Post-Formation.`,
          side_effects: einSideEffects,
        }
        break
      }

      // ─── PROCESS DOCUMENTS (re-run Drive folder + passport for a contact) ───
      case "process_documents": {
        const docSideEffects: string[] = []

        // Get contact info
        const { data: docContact } = await supabaseAdmin
          .from("contacts")
          .select("first_name, last_name, gdrive_folder_url")
          .eq("id", contact_id)
          .single()
        if (!docContact) {
          result = { success: false, detail: "Contact not found" }
          break
        }

        // Get wizard data for passport path
        const { data: wizards } = await supabaseAdmin
          .from("wizard_progress")
          .select("id, data, wizard_type, status")
          .eq("contact_id", contact_id)
          .eq("status", "submitted")
          .order("updated_at", { ascending: false })
          .limit(1)

        const wizard = wizards?.[0]
        if (!wizard?.data) {
          result = { success: false, detail: "No submitted wizard found for this contact" }
          break
        }

        const wizData = wizard.data as Record<string, unknown>
        const contactName = [docContact.first_name, docContact.last_name].filter(Boolean).join(" ") || "Unknown"

        // Get linked account (if any)
        const { data: acLinks } = await supabaseAdmin
          .from("account_contacts")
          .select("account_id")
          .eq("contact_id", contact_id)
          .limit(1)
        const linkedAccountId = acLinks?.[0]?.account_id ?? null

        // 1. Ensure contact Drive folder
        const { ensureContactFolder } = await import("@/lib/drive-folder-utils")
        const folderResult = await ensureContactFolder(contact_id, contactName)
        if (folderResult.created) {
          docSideEffects.push(`Drive folder created: Contacts/${contactName}/`)
        } else {
          docSideEffects.push("Drive folder already exists")
        }

        // 2. Copy passport from Storage to Drive
        const passportPath = wizData.passport_owner as string | undefined
        if (passportPath) {
          const contactsSubfolder = folderResult.subfolders["2. Contacts"]
          if (contactsSubfolder) {
            try {
              const cleanPath = passportPath.replace(/^\/+/, "")
              const { data: blob, error: dlErr } = await supabaseAdmin.storage
                .from("onboarding-uploads")
                .download(cleanPath)

              if (dlErr || !blob) {
                docSideEffects.push(`Passport download failed: ${dlErr?.message || "no data"}`)
              } else {
                const { uploadBinaryToDrive } = await import("@/lib/google-drive")
                const fileName = cleanPath.split("/").pop() || "passport.pdf"
                const buffer = Buffer.from(await blob.arrayBuffer())
                const mimeType = blob.type || "application/octet-stream"

                // Check if already uploaded (dedup by filename in folder)
                const { listFolderAnyDrive } = await import("@/lib/google-drive")
                const existingFilesRes = await listFolderAnyDrive(contactsSubfolder)
                const existingFiles = (existingFilesRes as { files?: Array<{ name: string }> }).files ?? []
                const alreadyUploaded = existingFiles.some(
                  (f: { name: string }) => f.name === fileName
                )

                if (alreadyUploaded) {
                  docSideEffects.push(`Passport already in Drive: ${fileName}`)
                } else {
                  const driveFile = await uploadBinaryToDrive(fileName, buffer, mimeType, contactsSubfolder) as { id: string }
                  docSideEffects.push(`Passport uploaded to Drive: ${fileName}`)

                  // OCR if supported
                  const ocrSupported = ["application/pdf", "image/jpeg", "image/png", "image/tiff", "image/gif", "image/bmp", "image/webp"]
                  if (ocrSupported.includes(mimeType)) {
                    try {
                      const { ocrDriveFile } = await import("@/lib/docai")
                      const { parsePassportFromOcr } = await import("@/lib/passport-processing")
                      const ocrResult = await ocrDriveFile(driveFile.id)

                      if (ocrResult.fullText) {
                        const passportData = parsePassportFromOcr(ocrResult.fullText)
                        const passportUpdates: Record<string, unknown> = {}
                        if (passportData.passportNumber) passportUpdates.passport_number = passportData.passportNumber
                        if (passportData.expiryDate) passportUpdates.passport_expiry_date = passportData.expiryDate
                        if (passportData.dateOfBirth) passportUpdates.date_of_birth = passportData.dateOfBirth

                        if (Object.keys(passportUpdates).length > 0) {
                          // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
                          await supabaseAdmin
                            .from("contacts")
                            .update({ ...passportUpdates, passport_on_file: true, updated_at: new Date().toISOString() })
                            .eq("id", contact_id)
                          docSideEffects.push(`Passport OCR extracted: ${Object.keys(passportUpdates).join(", ")}`)
                        } else {
                          docSideEffects.push("Passport OCR: no data extracted from MRZ")
                        }
                      }
                    } catch (ocrErr) {
                      docSideEffects.push(`Passport OCR error: ${ocrErr instanceof Error ? ocrErr.message : String(ocrErr)}`)
                    }
                  } else {
                    docSideEffects.push(`Passport format (${mimeType}) not supported for OCR — manual data entry needed`)
                    // Create manual task
                    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
                    await supabaseAdmin.from("tasks").insert({
                      task_title: `Manual passport data entry: ${contactName}`,
                      description: `Passport uploaded as ${mimeType}. Manually enter passport_number and passport_expiry_date.`,
                      assigned_to: "Luca",
                      category: "Document",
                      priority: "Normal",
                      status: "To Do",
                      contact_id: contact_id,
                      ...(linkedAccountId ? { account_id: linkedAccountId } : {}),
                    })
                    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
                    await supabaseAdmin
                      .from("contacts")
                      .update({ passport_on_file: true, updated_at: new Date().toISOString() })
                      .eq("id", contact_id)
                  }

                  // Create document record
                  // Check dedup first
                  const { data: existingDoc } = await supabaseAdmin
                    .from("documents")
                    .select("id")
                    .eq("contact_id", contact_id)
                    .eq("document_type_name", "Passport")
                    .limit(1)

                  if (!existingDoc?.length) {
                    await supabaseAdmin.from("documents").insert({
                      file_name: fileName,
                      drive_file_id: driveFile.id,
                      drive_link: `https://drive.google.com/file/d/${driveFile.id}/view`,
                      document_type_name: "Passport",
                      category: 2,
                      category_name: "Contacts",
                      status: "classified",
                      contact_id: contact_id,
                      account_id: linkedAccountId,
                      portal_visible: true,
                    })
                    docSideEffects.push("Document record created")
                  }
                }
              }
            } catch (passErr) {
              docSideEffects.push(`Passport error: ${passErr instanceof Error ? passErr.message : String(passErr)}`)
            }
          }
        } else {
          docSideEffects.push("No passport file in wizard data")
        }

        // Log
        await supabaseAdmin.from("action_log").insert({
          actor: "crm-admin",
          action_type: "process_documents",
          table_name: "contacts",
          record_id: contact_id,
          summary: `Documents processed for ${contactName}`,
          details: { side_effects: docSideEffects },
        })

        result = {
          success: true,
          detail: `Documents processed for ${contactName}`,
          side_effects: docSideEffects,
        }
        break
      }

      // ─── CANCEL SERVICE DELIVERY ───
      case "cancel_service": {
        const deliveryId = params?.delivery_id as string
        if (!deliveryId) {
          result = { success: false, detail: "Missing delivery_id" }
          break
        }

        const { data: sd } = await supabaseAdmin
          .from("service_deliveries")
          .select("id, service_name, service_type, status, account_id")
          .eq("id", deliveryId)
          .single()

        if (!sd) {
          result = { success: false, detail: "Service delivery not found" }
          break
        }
        if (sd.status === "cancelled") {
          result = { success: false, detail: "Already cancelled" }
          break
        }

        // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
        await supabaseAdmin
          .from("service_deliveries")
          .update({ status: "cancelled", end_date: new Date().toISOString().split("T")[0], updated_at: new Date().toISOString() })
          .eq("id", deliveryId)

        // Close any open tasks linked to this SD
        const { updateTasksBulk } = await import("@/lib/operations/task")
        const closeTasksResult = await updateTasksBulk({
          delivery_id: deliveryId,
          status_in: ["To Do", "In Progress", "Waiting"],
          patch: { status: "Done" },
          actor: "crm-admin:cancel-service",
          summary: `Auto-closed tasks for cancelled service ${sd.service_name || sd.service_type}`,
          account_id: sd.account_id,
        })
        const tasksClosed = closeTasksResult.count ?? 0

        await supabaseAdmin.from("action_log").insert({
          actor: "crm-admin",
          action_type: "cancel_service",
          table_name: "service_deliveries",
          record_id: deliveryId,
          account_id: sd.account_id,
          summary: `Service cancelled: ${sd.service_name || sd.service_type}`,
          details: { delivery_id: deliveryId, tasks_closed: tasksClosed },
        })

        result = {
          success: true,
          detail: `Cancelled: ${sd.service_name || sd.service_type}`,
          side_effects: [
            `Service delivery set to cancelled`,
            tasksClosed ? `${tasksClosed} linked task(s) closed` : "No linked tasks",
          ],
        }
        break
      }

      // ─── OCR DOCUMENT (run OCR on existing passport/ITIN in Drive) ───
      case "ocr_document": {
        const documentId = params?.document_id as string
        if (!documentId) {
          result = { success: false, detail: "Missing document_id" }
          break
        }

        const { data: doc } = await supabaseAdmin
          .from("documents")
          .select("id, file_name, drive_file_id, document_type_name, contact_id")
          .eq("id", documentId)
          .single()

        if (!doc || !doc.drive_file_id) {
          result = { success: false, detail: "Document not found or no Drive file" }
          break
        }

        const ocrSideEffects: string[] = []
        const docType = (doc.document_type_name || "").toLowerCase()
        const targetContactId = doc.contact_id || contact_id

        try {
          const { ocrDriveFile } = await import("@/lib/docai")
          const ocrResult = await ocrDriveFile(doc.drive_file_id)

          if (!ocrResult.fullText) {
            result = { success: false, detail: "OCR returned no text" }
            break
          }

          if (docType.includes("passport")) {
            const { parsePassportFromOcr } = await import("@/lib/passport-processing")
            const parsed = parsePassportFromOcr(ocrResult.fullText)

            const updates: Record<string, unknown> = {
              passport_on_file: true,
              updated_at: new Date().toISOString(),
            }
            if (parsed.passportNumber) updates.passport_number = parsed.passportNumber
            if (parsed.expiryDate) updates.passport_expiry_date = parsed.expiryDate
            if (parsed.dateOfBirth) updates.date_of_birth = parsed.dateOfBirth

            // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
            await supabaseAdmin.from("contacts").update(updates).eq("id", targetContactId)

            const extracted = Object.keys(updates).filter(k => k !== "passport_on_file" && k !== "updated_at")
            ocrSideEffects.push(extracted.length > 0
              ? `Passport OCR extracted: ${extracted.join(", ")}`
              : "Passport OCR ran but no MRZ data found — check image quality")
            if (parsed.passportNumber) ocrSideEffects.push(`Passport number: ${parsed.passportNumber}`)
            if (parsed.expiryDate) ocrSideEffects.push(`Expiry: ${parsed.expiryDate}`)

          } else if (docType.includes("itin")) {
            const itinMatch = ocrResult.fullText.match(/\b(9\d{2}[- ]?\d{2}[- ]?\d{4})\b/)
            if (itinMatch) {
              const rawItin = itinMatch[1].replace(/[- ]/g, "")
              const itinFormatted = `${rawItin.slice(0, 3)}-${rawItin.slice(3, 5)}-${rawItin.slice(5)}`

              // Extract issue date from CP565 OCR text (format: "Month DD, YYYY")
              const issueDate = parseItinIssueDateFromOcr(ocrResult.fullText)

              // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
              await supabaseAdmin.from("contacts").update({
                itin_number: itinFormatted,
                itin_issue_date: issueDate,
                updated_at: new Date().toISOString(),
              }).eq("id", targetContactId)

              ocrSideEffects.push(`ITIN extracted: ${itinFormatted}, issue date: ${issueDate}`)
            } else {
              ocrSideEffects.push("OCR ran but no ITIN number found (expected 9XX-XX-XXXX)")
            }

          } else if (docType.includes("ein")) {
            const einMatch = ocrResult.fullText.match(/\b(\d{2}[- ]?\d{7})\b/)
            if (einMatch) {
              const rawEin = einMatch[1].replace(/[- ]/g, "")
              const einFormatted = `${rawEin.slice(0, 2)}-${rawEin.slice(2)}`
              ocrSideEffects.push(`EIN found: ${einFormatted} (use Enter EIN on SS-4 card to save)`)
            } else {
              ocrSideEffects.push("OCR ran but no EIN found (expected XX-XXXXXXX)")
            }
          } else {
            ocrSideEffects.push(`OCR completed — ${ocrResult.fullText.length} chars extracted`)
          }

          // Log
          await supabaseAdmin.from("action_log").insert({
            actor: "crm-admin",
            action_type: "ocr_document",
            table_name: "documents",
            record_id: documentId,
            summary: `OCR ran on ${doc.file_name}: ${ocrSideEffects[0] || "completed"}`,
            details: { document_id: documentId, file_name: doc.file_name, side_effects: ocrSideEffects },
          })

          result = {
            success: true,
            detail: ocrSideEffects[0] || "OCR completed",
            side_effects: ocrSideEffects,
          }
        } catch (ocrErr) {
          const errMsg = ocrErr instanceof Error ? ocrErr.message : String(ocrErr)
          result = {
            success: false,
            detail: errMsg.includes("too large") ? "File too large for OCR (max 15MB)" : `OCR failed: ${errMsg}`,
          }
        }
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
