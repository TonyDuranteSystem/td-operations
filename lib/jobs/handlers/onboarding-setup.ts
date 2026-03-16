/**
 * Job Handler: onboarding_setup
 *
 * Executes the "slow" phase of the Magic Button:
 * - Drive folder creation + document copy
 * - Lease agreement auto-creation
 * - Follow-up tasks creation
 * - Tax return checks
 * - Portal fields
 * - Lead → Converted
 * - Form → reviewed
 *
 * The "fast" phase (Contact, Account, Link) is done inline by the MCP tool
 * before enqueuing this job.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { createFolder, uploadBinaryToDrive } from "@/lib/google-drive"
import type { Job, JobResult } from "../queue"
import { updateJobProgress } from "../queue"

interface OnboardingPayload {
  token: string
  submission_id: string
  account_id: string
  contact_id: string
  lead_id: string
  company_name: string
  state_of_formation: string
  entity_type: string  // "SMLLC" or "MMLLC"
  submitted_data: Record<string, unknown>
  upload_paths: string[] | null
}

function step(name: string, status: "ok" | "error" | "skipped", detail?: string) {
  return { name, status, detail, timestamp: new Date().toISOString() }
}

export async function handleOnboardingSetup(job: Job): Promise<JobResult> {
  const p = job.payload as unknown as OnboardingPayload
  const result: JobResult = { steps: [] }

  const { account_id, contact_id, company_name, state_of_formation, token } = p
  const submitted = p.submitted_data || {}
  const today = new Date().toISOString().slice(0, 10)
  const now = new Date().toISOString()

  // ─── 1. DRIVE FOLDER + DOCUMENT COPY ───
  let driveFolderId: string | null = null
  if (company_name && state_of_formation) {
    try {
      // Check if account already has a drive folder
      const { data: acct } = await supabaseAdmin
        .from("accounts")
        .select("drive_folder_id")
        .eq("id", account_id)
        .single()

      if (acct?.drive_folder_id) {
        driveFolderId = acct.drive_folder_id
        result.steps.push(step("drive_folder", "skipped", `Already exists: ${driveFolderId}`))
      } else {
        const stateFolderMap: Record<string, string> = {
          "New Mexico": "1tkJjg0HKbIl0uFzvK4zW3rtU14sdCHo4",
          "NM": "1tkJjg0HKbIl0uFzvK4zW3rtU14sdCHo4",
          "Wyoming": "110NUZZJC1mf3vKB12bmxfRFIVZJ3SE5x",
          "WY": "110NUZZJC1mf3vKB12bmxfRFIVZJ3SE5x",
          "Delaware": "1QoF8WZsW_TT-cXM9NxLeTN1ng1jqbZM-",
          "DE": "1QoF8WZsW_TT-cXM9NxLeTN1ng1jqbZM-",
          "Florida": "1XToxqPl-t6z10raeal_frSpvBBBRY8nG",
          "FL": "1XToxqPl-t6z10raeal_frSpvBBBRY8nG",
        }
        const companiesRootId = "1Z32I4pDzX4enwqJQzolbFw7fK94ISuCb"
        let parentFolderId = stateFolderMap[state_of_formation] || null

        if (!parentFolderId) {
          const newStateFolder = await createFolder(companiesRootId, state_of_formation) as { id: string }
          parentFolderId = newStateFolder.id
        }

        // Folder naming: "{Company Name} - {Owner Name}" per Drive convention
        let folderName = company_name
        if (contact_id) {
          const { data: ownerContact } = await supabaseAdmin
            .from("contacts")
            .select("first_name, last_name")
            .eq("id", contact_id)
            .single()
          if (ownerContact) {
            const ownerName = [ownerContact.first_name, ownerContact.last_name].filter(Boolean).join(" ")
            if (ownerName) folderName = `${company_name} - ${ownerName}`
          }
        }

        const companyFolder = await createFolder(parentFolderId, folderName) as { id: string }
        driveFolderId = companyFolder.id

        // Create 5 subfolders from _TEMPLATE structure
        const templateSubfolders = [
          "1. Company", "2. Contacts", "3. Tax", "4. Banking", "5. Correspondence"
        ]
        for (const subName of templateSubfolders) {
          try {
            await createFolder(driveFolderId, subName)
          } catch (subErr) {
            console.warn(`[onboarding-setup] Failed to create subfolder ${subName}:`, subErr)
          }
        }

        // Set drive_folder_id on account
        await supabaseAdmin
          .from("accounts")
          .update({ drive_folder_id: driveFolderId })
          .eq("id", account_id)

        result.steps.push(step("drive_folder", "ok", `Created: ${driveFolderId}`))
      }

      await updateJobProgress(job.id, result)

      // Copy uploaded documents
      const uploads = p.upload_paths
      if (uploads && uploads.length > 0 && driveFolderId) {
        let copied = 0
        let failed = 0
        for (const filePath of uploads) {
          try {
            const cleanPath = filePath.replace(/^\/+/, "")
            const { data: blob, error: dlErr } = await supabaseAdmin.storage
              .from("onboarding-uploads")
              .download(cleanPath)

            if (dlErr || !blob) {
              result.steps.push(step(`doc_copy:${cleanPath}`, "error", dlErr?.message || "no data"))
              failed++
              continue
            }

            const arrayBuffer = await blob.arrayBuffer()
            const fileData = Buffer.from(arrayBuffer)
            const fileName = cleanPath.split("/").pop() || `file-${Date.now()}`
            const mimeType = blob.type || "application/pdf"

            const driveResult = await uploadBinaryToDrive(fileName, fileData, mimeType, driveFolderId) as { id: string; name: string }
            result.steps.push(step(`doc_copy:${fileName}`, "ok", driveResult.id))
            copied++
          } catch (e) {
            result.steps.push(step(`doc_copy:${filePath}`, "error", e instanceof Error ? e.message : String(e)))
            failed++
          }
        }
        result.steps.push(step("doc_copy_summary", copied > 0 ? "ok" : "error", `${copied} copied, ${failed} failed`))
      } else {
        result.steps.push(step("doc_copy", "skipped", "No uploads"))
      }

      await updateJobProgress(job.id, result)
    } catch (e) {
      result.steps.push(step("drive_folder", "error", e instanceof Error ? e.message : String(e)))
      await updateJobProgress(job.id, result)
    }
  }

  // ─── 2. AUTO-CREATE LEASE AGREEMENT ───
  if (account_id && company_name && contact_id) {
    try {
      const year = new Date().getFullYear()
      const { data: existingLease } = await supabaseAdmin
        .from("lease_agreements")
        .select("id, token, status")
        .eq("account_id", account_id)
        .eq("contract_year", year)
        .limit(1)

      if (existingLease?.length) {
        result.steps.push(step("lease", "skipped", `Already exists: ${existingLease[0].token}`))
      } else {
        // Auto-assign next suite number
        const { data: lastSuite } = await supabaseAdmin
          .from("lease_agreements")
          .select("suite_number")
          .like("suite_number", "3D-%")
          .order("suite_number", { ascending: false })
          .limit(1)

        let nextNum = 101
        if (lastSuite?.length) {
          const match = lastSuite[0].suite_number.match(/3D-(\d+)/)
          if (match) nextNum = parseInt(match[1], 10) + 1
        }
        const suiteNumber = `3D-${nextNum}`

        const { data: leaseContact } = await supabaseAdmin
          .from("contacts")
          .select("id, full_name, email, language")
          .eq("id", contact_id)
          .single()

        const { data: leaseAccount } = await supabaseAdmin
          .from("accounts")
          .select("id, company_name, ein_number, state_of_formation")
          .eq("id", account_id)
          .single()

        if (leaseContact && leaseAccount) {
          const companySlug = company_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
          const leaseToken = `${companySlug}-${year}`

          const { data: newLease, error: leaseErr } = await supabaseAdmin
            .from("lease_agreements")
            .insert({
              token: leaseToken,
              account_id,
              contact_id,
              tenant_company: leaseAccount.company_name,
              tenant_ein: leaseAccount.ein_number || null,
              tenant_state: leaseAccount.state_of_formation || null,
              tenant_contact_name: leaseContact.full_name,
              tenant_email: leaseContact.email || null,
              premises_address: "10225 Ulmerton Rd, Largo, FL 33771",
              suite_number: suiteNumber,
              square_feet: 120,
              effective_date: today,
              term_start_date: today,
              term_end_date: `${year}-12-31`,
              term_months: 12,
              contract_year: year,
              monthly_rent: 100,
              yearly_rent: 1200,
              security_deposit: 150,
              language: leaseContact.language?.toLowerCase()?.startsWith("it") ? "it" : "en",
              status: "draft",
            })
            .select("id, token, access_code")
            .single()

          if (leaseErr || !newLease) {
            result.steps.push(step("lease", "error", leaseErr?.message || "unknown"))
          } else {
            result.steps.push(step("lease", "ok", `${newLease.token} (Suite ${suiteNumber})`))
          }
        } else {
          result.steps.push(step("lease", "error", "Could not fetch contact/account details"))
        }
      }
      await updateJobProgress(job.id, result)
    } catch (e) {
      result.steps.push(step("lease", "error", e instanceof Error ? e.message : String(e)))
      await updateJobProgress(job.id, result)
    }
  }

  // ─── 3. CREATE SERVICE DELIVERY + FOLLOW-UP TASKS ───
  let onboardingDeliveryId: string | null = null
  if (account_id && company_name) {
    // 3a. Create or find Client Onboarding service delivery
    try {
      const { data: existingSD } = await supabaseAdmin
        .from("service_deliveries")
        .select("id")
        .eq("account_id", account_id)
        .eq("service_type", "Client Onboarding")
        .eq("status", "active")
        .maybeSingle()

      if (existingSD) {
        onboardingDeliveryId = existingSD.id
        result.steps.push(step("service_delivery", "skipped", `Already exists: ${existingSD.id}`))
      } else {
        // Get stage 2 (Review & CRM Setup) since Magic Button IS the review
        const { data: stage2 } = await supabaseAdmin
          .from("pipeline_stages")
          .select("stage_name, stage_order")
          .eq("service_type", "Client Onboarding")
          .eq("stage_order", 2)
          .maybeSingle()

        const stageName = stage2?.stage_name || "Review & CRM Setup"
        const stageOrder = stage2?.stage_order || 2

        // Resolve pricing from offer (if available)
        let sdAmount: number | null = null
        let sdCurrency = "USD"
        if (p.lead_id) {
          const { data: offer } = await supabaseAdmin
            .from("offers")
            .select("services")
            .eq("lead_id", p.lead_id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle()

          if (offer?.services && Array.isArray(offer.services)) {
            // Prefer the recommended service, fallback to first
            const svc = offer.services.find((s: Record<string, unknown>) => s.recommended) || offer.services[0]
            if (svc?.price && typeof svc.price === "string") {
              // Parse price strings like "EUR 2,300", "$1,500", "USD 900"
              const match = svc.price.match(/^(EUR|USD|\$|€)?\s*([\d,.]+)$/i)
              if (match) {
                const currencyPart = (match[1] || "").toUpperCase()
                sdCurrency = currencyPart === "EUR" || currencyPart === "€" ? "EUR" : "USD"
                sdAmount = parseFloat(match[2].replace(/,/g, ""))
              }
            }
          }
        }

        const { data: newSD, error: sdErr } = await supabaseAdmin
          .from("service_deliveries")
          .insert({
            service_name: `Client Onboarding - ${company_name}`,
            service_type: "Client Onboarding",
            pipeline: "Client Onboarding",
            stage: stageName,
            stage_order: stageOrder,
            stage_entered_at: now,
            stage_history: [{ to_stage: stageName, to_order: stageOrder, advanced_at: now, notes: "Created by Magic Button (skipped Data Collection)" }],
            account_id,
            contact_id: contact_id || null,
            status: "active",
            start_date: today,
            assigned_to: "Luca",
            ...(sdAmount != null && { amount: sdAmount, amount_currency: sdCurrency }),
          })
          .select("id")
          .single()

        if (sdErr || !newSD) {
          result.steps.push(step("service_delivery", "error", sdErr?.message || "unknown"))
        } else {
          onboardingDeliveryId = newSD.id
          result.steps.push(step("service_delivery", "ok", `Created: ${newSD.id} (stage: ${stageName})`))
        }
      }
      await updateJobProgress(job.id, result)
    } catch (e) {
      result.steps.push(step("service_delivery", "error", e instanceof Error ? e.message : String(e)))
    }

    // 3b. Create follow-up tasks linked to service delivery
    const taskDefs = [
      { title: `Create WhatsApp group — ${company_name}`, assigned_to: "Luca", category: "Client Communication", priority: "High" },
      { title: `Review and send lease agreement — ${company_name}`, assigned_to: "Antonio", category: "Document", priority: "High" },
      { title: `Registered Agent change — ${company_name}`, assigned_to: "Luca", category: "Formation", priority: "High" },
    ]
    for (const td of taskDefs) {
      try {
        // Check if task already exists (idempotent)
        const { data: existingTask } = await supabaseAdmin
          .from("tasks")
          .select("id")
          .eq("task_title", td.title)
          .eq("account_id", account_id)
          .maybeSingle()

        if (existingTask) {
          result.steps.push(step(`task:${td.assigned_to}`, "skipped", td.title))
          continue
        }

        const { error: taskErr } = await supabaseAdmin
          .from("tasks")
          .insert({
            task_title: td.title,
            assigned_to: td.assigned_to,
            category: td.category,
            priority: td.priority,
            status: "To Do",
            account_id,
            created_by: "Claude",
            delivery_id: onboardingDeliveryId,
            stage_order: 2, // Review & CRM Setup stage
          })
        if (taskErr) {
          result.steps.push(step(`task:${td.assigned_to}`, "error", taskErr.message))
        } else {
          result.steps.push(step(`task:${td.assigned_to}`, "ok", td.title))
        }
      } catch (e) {
        result.steps.push(step(`task:${td.assigned_to}`, "error", e instanceof Error ? e.message : String(e)))
      }
    }
    await updateJobProgress(job.id, result)
  }

  // ─── 4. CHECK TAX RETURN STATUS ───
  if (account_id && company_name) {
    const returnType = p.entity_type === "MMLLC" ? "MMLLC" : "SMLLC"
    const currentYear = new Date().getFullYear()
    const previousYear = currentYear - 1
    const deadlineMonth = returnType === "MMLLC" ? "03" : "04"

    const taxChecks = [
      { year: previousYear, field: "tax_return_previous_year_filed", label: "Previous year" },
      { year: currentYear, field: "tax_return_current_year_filed", label: "Current year" },
    ]

    for (const tc of taxChecks) {
      const fieldValue = String(submitted[tc.field] || "").toLowerCase()
      if (fieldValue === "no" || fieldValue === "not sure") {
        try {
          const { data: existingTR } = await supabaseAdmin
            .from("tax_returns")
            .select("id")
            .eq("account_id", account_id)
            .eq("tax_year", tc.year)
            .maybeSingle()

          if (existingTR) {
            result.steps.push(step(`tax_return:${tc.year}`, "skipped", `Already exists: ${existingTR.id}`))
          } else {
            const deadline = `${tc.year + 1}-${deadlineMonth}-15`
            const { error: trErr } = await supabaseAdmin
              .from("tax_returns")
              .insert({
                account_id,
                company_name,
                return_type: returnType,
                tax_year: tc.year,
                deadline,
                status: "Not Invoiced",
              })
            if (trErr) {
              result.steps.push(step(`tax_return:${tc.year}`, "error", trErr.message))
            } else {
              result.steps.push(step(`tax_return:${tc.year}`, "ok", `Created (deadline: ${deadline})`))
            }
          }
        } catch (e) {
          result.steps.push(step(`tax_return:${tc.year}`, "error", e instanceof Error ? e.message : String(e)))
        }
      } else {
        result.steps.push(step(`tax_return:${tc.year}`, "skipped", `Client says: ${submitted[tc.field] || "N/A"}`))
      }
    }
    await updateJobProgress(job.id, result)
  }

  // ─── 5. SET PORTAL FIELDS ───
  if (account_id) {
    try {
      const { error: portalErr } = await supabaseAdmin
        .from("accounts")
        .update({ portal_account: true, portal_created_date: today })
        .eq("id", account_id)
      if (portalErr) {
        result.steps.push(step("portal", "error", portalErr.message))
      } else {
        result.steps.push(step("portal", "ok", `portal_account=true`))
      }
    } catch (e) {
      result.steps.push(step("portal", "error", e instanceof Error ? e.message : String(e)))
    }
  }

  // ─── 6. LEAD CONVERSION — SKIPPED (now happens at payment in whop webhook / check-wire-payments) ───
  result.steps.push(step("lead_converted", "skipped", "Moved to payment confirmation (Change 1.1)"))

  // ─── 7. MARK FORM AS REVIEWED ───
  try {
    const { error: formErr } = await supabaseAdmin
      .from("onboarding_submissions")
      .update({
        status: "reviewed",
        reviewed_at: now,
        reviewed_by: "claude",
      })
      .eq("id", p.submission_id)
    if (formErr) {
      result.steps.push(step("form_reviewed", "error", formErr.message))
    } else {
      result.steps.push(step("form_reviewed", "ok", "Form → reviewed"))
    }
  } catch (e) {
    result.steps.push(step("form_reviewed", "error", e instanceof Error ? e.message : String(e)))
  }

  // ─── 8. UPDATE SUBMISSION WITH ACCOUNT/CONTACT IDs ───
  try {
    const subUpdates: Record<string, unknown> = { updated_at: now }
    if (account_id) subUpdates.account_id = account_id
    if (contact_id) subUpdates.contact_id = contact_id
    await supabaseAdmin
      .from("onboarding_submissions")
      .update(subUpdates)
      .eq("id", p.submission_id)
    result.steps.push(step("submission_ids", "ok", "Updated account_id/contact_id"))
  } catch (e) {
    result.steps.push(step("submission_ids", "error", e instanceof Error ? e.message : String(e)))
  }

  // Summary
  const okCount = result.steps.filter(s => s.status === "ok").length
  const errCount = result.steps.filter(s => s.status === "error").length
  const skipCount = result.steps.filter(s => s.status === "skipped").length
  result.summary = `${okCount} ok, ${errCount} errors, ${skipCount} skipped`

  return result
}
