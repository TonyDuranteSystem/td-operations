/**
 * Job Handler: onboarding_setup
 *
 * Full auto-chain for onboarding wizard submissions:
 * - Data validation (EIN format, required fields)
 * - Contact update (DOB, nationality, address from wizard)
 * - Account creation or update (if not provided)
 * - Drive folder creation + document copy
 * - Lease agreement auto-creation
 * - Operating Agreement auto-creation
 * - Follow-up tasks creation
 * - Tax return checks
 * - Portal fields + tier upgrade
 * - Form → reviewed
 * - Portal notification to Contact
 * - Welcome package chain
 *
 * Triggered by:
 * 1. Portal wizard-submit (source: 'portal_wizard') — account_id may be null
 * 2. MCP Magic Button (source: undefined) — account_id always provided
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { uploadBinaryToDrive } from "@/lib/google-drive"
import { OA_SUPPORTED_STATES } from "@/lib/types/oa-templates"
import { createAccountFromWizard } from "@/lib/account-from-wizard"
import { updateJobProgress, type Job, type JobResult } from "../queue"
import { validateOnboardingData, normalizeEIN } from "../validation"
import { runOCRCrossCheck } from "../ocr-crosscheck"
import type { Json } from "@/lib/database.types"

interface OnboardingPayload {
  token: string
  submission_id: string | null
  account_id: string | null
  contact_id: string | null
  lead_id: string | null
  company_name: string
  state_of_formation: string
  entity_type: string  // "SMLLC" or "MMLLC"
  submitted_data: Record<string, unknown>
  upload_paths: string[] | null
  source?: "portal_wizard" | string  // Where this job was triggered from
}

function step(name: string, status: "ok" | "error" | "skipped", detail?: string) {
  return { name, status, detail, timestamp: new Date().toISOString() }
}

export async function handleOnboardingSetup(job: Job): Promise<JobResult> {
  const p = job.payload as unknown as OnboardingPayload
  const result: JobResult = { steps: [] }

  let { account_id } = p
  const { contact_id } = p
  const { company_name, state_of_formation, token } = p
  const submitted = p.submitted_data || {}
  const today = new Date().toISOString().slice(0, 10)
  const now = new Date().toISOString()

  // ─── 0. VALIDATE WIZARD DATA ───
  const validation = validateOnboardingData(submitted)
  if (!validation.valid) {
    const errDetail = validation.errors.map(e => `${e.field}: ${e.message}`).join("; ")
    result.steps.push(step("validation", "error", errDetail))

    // Create task for staff to review the invalid data
    if (contact_id) {
      try {
        // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
        await supabaseAdmin.from("tasks").insert({
          task_title: `Wizard validation failed — ${company_name || token}`,
          description: [
            "Auto-chain blocked due to validation errors:",
            ...validation.errors.map(e => `- ${e.field}: ${e.message}`),
            "",
            token ? `Review: onboarding_form_review(token="${token}")` : "",
          ].filter(Boolean).join("\n"),
          status: "To Do",
          priority: "High",
          category: "Client Response",
          assigned_to: "Luca",
          account_id: account_id || null,
          created_by: "Claude",
        })
      } catch {
        // Non-blocking
      }
    }

    result.summary = `Validation failed: ${validation.errors.length} error(s)`
    result.ok = false
    return result
  }

  if (validation.warnings.length > 0) {
    const warnDetail = validation.warnings.map(w => `${w.field}: ${w.message}`).join("; ")
    result.steps.push(step("validation", "ok", `Passed with ${validation.warnings.length} warning(s): ${warnDetail}`))
  } else {
    result.steps.push(step("validation", "ok", "All checks passed"))
  }
  await updateJobProgress(job.id, result)

  // ─── 0a. UPDATE CONTACT WITH WIZARD DATA ───
  if (contact_id) {
    try {
      const contactUpdates: Record<string, unknown> = { updated_at: now }
      if (submitted.owner_first_name) contactUpdates.first_name = submitted.owner_first_name
      if (submitted.owner_last_name) contactUpdates.last_name = submitted.owner_last_name
      if (submitted.owner_dob) contactUpdates.date_of_birth = submitted.owner_dob
      if (submitted.owner_nationality) contactUpdates.citizenship = submitted.owner_nationality
      // Address lives on contacts.residency as a single formatted string
      // (Antonio's CRM model: residency = full residential address).
      // Concatenates street / city / state / zip / country with commas.
      if (submitted.owner_street || submitted.owner_city || submitted.owner_country) {
        const addressParts = [
          submitted.owner_street,
          submitted.owner_city,
          submitted.owner_state_province,
          submitted.owner_zip,
          submitted.owner_country,
        ].filter(Boolean).map(String).map(s => s.trim())
        if (addressParts.length > 0) {
          contactUpdates.residency = addressParts.join(", ")
        }
      }
      if (submitted.owner_itin) contactUpdates.itin_number = submitted.owner_itin

      const fieldCount = Object.keys(contactUpdates).filter(k => k !== "updated_at").length
      if (fieldCount > 0) {
        // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
        const { error: upErr } = await supabaseAdmin
          .from("contacts")
          .update(contactUpdates)
          .eq("id", contact_id)
        result.steps.push(upErr
          ? step("contact_update", "error", upErr.message)
          : step("contact_update", "ok", `${fieldCount} fields updated`))
      } else {
        result.steps.push(step("contact_update", "skipped", "No contact fields in wizard data"))
      }
    } catch (e) {
      result.steps.push(step("contact_update", "error", e instanceof Error ? e.message : String(e)))
    }
    await updateJobProgress(job.id, result)
  }

  // ─── 0b. OCR CROSS-CHECK (uploaded docs vs wizard data) ───
  try {
    const ocrResult = await runOCRCrossCheck(submitted, p.upload_paths)
    if (ocrResult.checks.length === 0) {
      result.steps.push(step("ocr_crosscheck", "skipped", ocrResult.summary))
    } else if (ocrResult.hasBlockers) {
      // Mismatch found — block chain, create task for staff
      const mismatchDetail = ocrResult.checks
        .filter(c => c.status === "mismatch")
        .map(c => `${c.field}: wizard="${c.wizardValue}" vs OCR="${c.ocrValue}" (${c.similarity}%)`)
        .join("; ")
      result.steps.push(step("ocr_crosscheck", "error", `BLOCKED: ${mismatchDetail}`))

      // Create review task
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
      await supabaseAdmin.from("tasks").insert({
        task_title: `OCR mismatch — ${company_name || token}`,
        description: [
          "Auto-chain blocked due to document mismatch:",
          ...ocrResult.checks.filter(c => c.status === "mismatch" || c.status === "warning").map(c =>
            `- ${c.field}: wizard="${c.wizardValue}" vs OCR="${c.ocrValue}" (${c.similarity}%)`
          ),
          "",
          token ? `Review: onboarding_form_review(token="${token}")` : "",
        ].filter(Boolean).join("\n"),
        status: "To Do",
        priority: "Urgent",
        category: "Client Response",
        assigned_to: "Luca",
        account_id: account_id || null,
        created_by: "Claude",
      }).then(() => {}, () => {}) // non-blocking

      result.summary = `OCR cross-check blocked: ${mismatchDetail}`
      result.ok = false
      return result
    } else {
      const detail = ocrResult.checks.map(c => `${c.field}:${c.status}(${c.similarity}%)`).join(", ")
      result.steps.push(step("ocr_crosscheck", "ok", `${ocrResult.summary} — ${detail}`))
    }
  } catch (e) {
    // OCR failure is non-blocking — log warning and continue
    result.steps.push(step("ocr_crosscheck", "skipped", `OCR failed (non-blocking): ${e instanceof Error ? e.message : String(e)}`))
  }
  await updateJobProgress(job.id, result)

  // ─── 0c. CREATE ACCOUNT IF NOT PROVIDED ───
  if (!account_id && company_name && contact_id) {
    try {
      const acctResult = await createAccountFromWizard({
        contactId: contact_id,
        companyName: company_name,
        entityType: p.entity_type,
        stateOfFormation: state_of_formation,
        ein: submitted.ein ? String(submitted.ein) : null,
        formationDate: submitted.formation_date ? String(submitted.formation_date) : null,
        accountType: "Client",
      })

      if (acctResult.error) {
        result.steps.push(step("account_create", "error", acctResult.error))
      } else if (!acctResult.created) {
        account_id = acctResult.accountId
        result.steps.push(step("account_create", "skipped", `Already exists: ${account_id}`))
      } else {
        account_id = acctResult.accountId

        result.steps.push(step("account_create", "ok", `${company_name} (${p.entity_type}) → linked to contact`))

        // Update submission with account_id for traceability
        if (p.submission_id) {
          await supabaseAdmin
            .from("onboarding_submissions")
            .update({ account_id })
            .eq("id", p.submission_id)
        }

        // Update the job itself with account_id
        await supabaseAdmin
          .from("job_queue")
          .update({ account_id })
          .eq("id", job.id)

        if (acctResult.backfilled.invoices > 0 || acctResult.backfilled.payments > 0) {
          result.steps.push(step("invoice_backfill", "ok", `Backfilled account_id on ${acctResult.backfilled.invoices} invoices, ${acctResult.backfilled.payments} payments`))
        }
      }
    } catch (e) {
      result.steps.push(step("account_create", "error", e instanceof Error ? e.message : String(e)))
    }
    await updateJobProgress(job.id, result)
  } else if (account_id && company_name) {
    // Account exists — update it with wizard data
    try {
      const accountUpdates: Record<string, unknown> = { updated_at: now }
      if (submitted.company_name) accountUpdates.company_name = submitted.company_name
      if (submitted.ein) {
        // Canonical XX-XXXXXXX storage format. See Bug 2 / dev_task 3d6800c8.
        const canonical = normalizeEIN(submitted.ein as string)
        if (canonical) accountUpdates.ein_number = canonical
      }
      if (submitted.formation_date) accountUpdates.formation_date = submitted.formation_date
      if (submitted.state_of_formation) accountUpdates.state_of_formation = submitted.state_of_formation
      if (submitted.registered_agent) accountUpdates.registered_agent_provider = submitted.registered_agent

      const fieldCount = Object.keys(accountUpdates).filter(k => k !== "updated_at").length
      if (fieldCount > 0) {
        // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
        await supabaseAdmin.from("accounts").update(accountUpdates).eq("id", account_id)
        result.steps.push(step("account_update", "ok", `${fieldCount} fields updated`))
      } else {
        result.steps.push(step("account_update", "skipped", "No account fields in wizard data"))
      }
    } catch (e) {
      result.steps.push(step("account_update", "error", e instanceof Error ? e.message : String(e)))
    }
    await updateJobProgress(job.id, result)
  }

  // ─── 1. DRIVE FOLDER + DOCUMENT COPY ───
  let driveFolderId: string | null = null
  if (company_name && state_of_formation) {
    try {
      // Resolve owner name for folder naming
      let ownerName = ""
      if (contact_id) {
        const { data: ownerContact } = await supabaseAdmin
          .from("contacts")
          .select("first_name, last_name")
          .eq("id", contact_id)
          .single()
        if (ownerContact) {
          ownerName = [ownerContact.first_name, ownerContact.last_name].filter(Boolean).join(" ")
        }
      }

      const { ensureCompanyFolder } = await import("@/lib/drive-folder-utils")
      const folderResult = await ensureCompanyFolder(account_id, company_name, state_of_formation, ownerName || undefined)
      driveFolderId = folderResult.folderId
      result.steps.push(step("drive_folder", folderResult.created ? "ok" : "skipped",
        folderResult.created ? `Created: ${driveFolderId}` : `Already exists: ${driveFolderId}`
      ))

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

      // Generate data summary PDF
      if (driveFolderId && submitted && Object.keys(submitted).length > 0) {
        try {
          const { generateFormSummaryPDF } = await import("@/lib/form-to-drive")
          const { FORM_CONFIGS } = await import("@/lib/form-to-drive")
          const config = FORM_CONFIGS["onboarding"]
          const summaryPdf = await generateFormSummaryPDF(config, submitted, {
            token,
            submittedAt: now,
            companyName: company_name,
            uploadCount: (p.upload_paths || []).length,
          })
          const slug = company_name.replace(/\s+/g, "_")
          const uploadResult = await uploadBinaryToDrive(
            `Onboarding_Data_${slug}.pdf`,
            Buffer.from(summaryPdf),
            "application/pdf",
            driveFolderId
          ) as { id: string }
          result.steps.push(step("data_summary_pdf", "ok", `Uploaded: ${uploadResult.id}`))
        } catch (e) {
          result.steps.push(step("data_summary_pdf", "error", e instanceof Error ? e.message : String(e)))
        }
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
      const { createLease } = await import("@/lib/operations/lease")
      const leaseResult = await createLease({
        account_id,
        contact_id,
        effective_date: today,
        term_start_date: today,
        actor: "system:onboarding-setup",
        summary: `Auto-created lease during onboarding setup for ${company_name}`,
      })

      if (leaseResult.outcome === "duplicate" && leaseResult.existing) {
        result.steps.push(step("lease", "skipped", `Already exists: ${leaseResult.existing.token}`))
      } else if (leaseResult.success && leaseResult.lease) {
        result.steps.push(step("lease", "ok", `${leaseResult.lease.token} (Suite ${leaseResult.lease.suite_number})`))
      } else {
        result.steps.push(step("lease", "error", leaseResult.error || "unknown"))
      }
      await updateJobProgress(job.id, result)
    } catch (e) {
      result.steps.push(step("lease", "error", e instanceof Error ? e.message : String(e)))
      await updateJobProgress(job.id, result)
    }
  }

  // ─── 2b. AUTO-CREATE OPERATING AGREEMENT ───
  if (account_id && company_name && contact_id && state_of_formation) {
    try {
      const { data: existingOa } = await supabaseAdmin
        .from("oa_agreements")
        .select("id, token, status")
        .eq("account_id", account_id)
        .limit(1)

      if (existingOa?.length) {
        result.steps.push(step("oa", "skipped", `Already exists: ${existingOa[0].token} (${existingOa[0].status})`))
      } else {
        const stateCode = state_of_formation.toUpperCase().replace("NEW MEXICO", "NM").replace("WYOMING", "WY").replace("FLORIDA", "FL").replace("DELAWARE", "DE")
        if (!OA_SUPPORTED_STATES.includes(stateCode as typeof OA_SUPPORTED_STATES[number])) {
          result.steps.push(step("oa", "skipped", `State "${state_of_formation}" not supported for OA (${OA_SUPPORTED_STATES.join(", ")})`))
        } else {
          const year = new Date().getFullYear()
          const companySlug = company_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
          const oaToken = `${companySlug}-oa-${year}`

          // Fetch contact details for OA
          const { data: oaContact } = await supabaseAdmin
            .from("contacts")
            .select("id, full_name, email, language")
            .eq("id", contact_id)
            .single()

          // Fetch account details for OA
          const { data: oaAccount } = await supabaseAdmin
            .from("accounts")
            .select("id, company_name, ein_number, physical_address, registered_agent_provider, registered_agent_address, formation_date")
            .eq("id", account_id)
            .single()

          if (oaContact && oaAccount) {
            // Determine entity type from payload
            const entityType = p.entity_type === "MMLLC" ? "MMLLC" : "SMLLC"

            // Build members array for MMLLC
            let membersJson: Record<string, unknown>[] | null = null
            if (entityType === "MMLLC") {
              const { data: allContactLinks } = await supabaseAdmin
                .from("account_contacts")
                .select("contact_id")
                .eq("account_id", account_id)

              if (allContactLinks && allContactLinks.length > 1) {
                const { data: memberContacts } = await supabaseAdmin
                  .from("contacts")
                  .select("full_name, email")
                  .in("id", allContactLinks.map(c => c.contact_id))

                if (memberContacts && memberContacts.length > 1) {
                  const pct = Math.floor(100 / memberContacts.length)
                  const remainder = 100 - pct * memberContacts.length
                  membersJson = memberContacts.map((mc, i) => ({
                    name: mc.full_name,
                    email: mc.email || null,
                    ownership_pct: pct + (i === 0 ? remainder : 0),
                    initial_contribution: "$0 (No initial capital contribution required)",
                  }))
                }
              }
            }

            const { data: newOa, error: oaErr } = await supabaseAdmin
              .from("oa_agreements")
              .insert({
                token: oaToken,
                account_id,
                contact_id,
                company_name: oaAccount.company_name,
                state_of_formation: stateCode,
                formation_date: oaAccount.formation_date || today,
                ein_number: oaAccount.ein_number || null,
                entity_type: entityType,
                manager_name: oaContact.full_name,
                member_name: oaContact.full_name,
                member_address: oaAccount.physical_address || null,
                member_email: oaContact.email || null,
                members: membersJson as unknown as Json,
                effective_date: oaAccount.formation_date || today,
                business_purpose: "any and all lawful business activities",
                initial_contribution: "$0 (No initial capital contribution required)",
                fiscal_year_end: "December 31",
                accounting_method: "Cash",
                duration: "Perpetual",
                registered_agent_name: oaAccount.registered_agent_provider || null,
                registered_agent_address: oaAccount.registered_agent_address || null,
                principal_address: oaAccount.physical_address || "10225 Ulmerton Rd, Suite 3D, Largo, FL 33771",
                language: "en",
                status: "draft",
              })
              .select("id, token, access_code")
              .single()

            if (oaErr || !newOa) {
              result.steps.push(step("oa", "error", oaErr?.message || "insert failed"))
            } else {
              result.steps.push(step("oa", "ok", `${newOa.token} (${entityType}, draft)`))
            }
          } else {
            result.steps.push(step("oa", "error", "Could not fetch contact/account details for OA"))
          }
        }
      }
      await updateJobProgress(job.id, result)
    } catch (e) {
      result.steps.push(step("oa", "error", e instanceof Error ? e.message : String(e)))
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
            const svcs = offer.services as Array<Record<string, unknown>>
            const svc = svcs.find((s) => s.recommended) || svcs[0]
            if (svc?.price && typeof svc.price === "string") {
              // Parse price strings like "EUR 2,300", "$1,500", "USD 900"
              const match = (svc.price as string).match(/^(EUR|USD|\$|€)?\s*([\d,.]+)$/i)
              if (match) {
                const currencyPart = (match[1] || "").toUpperCase()
                sdCurrency = currencyPart === "EUR" || currencyPart === "€" ? "EUR" : "USD"
                sdAmount = parseFloat(match[2].replace(/,/g, ""))
              }
            }
          }
        }

        // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
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

        // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
        const { error: taskErr } = await supabaseAdmin
          .from("tasks")
          .insert({
            task_title: td.title,
            assigned_to: td.assigned_to,
            category: td.category as never,
            priority: td.priority as never,
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

    // Only create tax return for previous year — current year is still in progress,
    // nothing to file yet. Current year returns are created by the annual installment handler.
    const taxChecks = [
      { year: previousYear, field: "tax_return_previous_year_filed", label: "Previous year" },
    ]

    // Check if tax return is bundled (included) in the client's offer
    let taxReturnIncludedInOffer = false
    if (p.lead_id) {
      const { data: offer } = await supabaseAdmin
        .from("offers")
        .select("services, bundled_pipelines")
        .eq("lead_id", p.lead_id)
        .in("status", ["completed", "signed", "viewed", "sent"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      if (offer?.services && offer?.bundled_pipelines) {
        const pipelines = Array.isArray(offer.bundled_pipelines) ? offer.bundled_pipelines : []
        const services = Array.isArray(offer.services) ? offer.services : []
        if (pipelines.some((p: string) => /tax.return/i.test(p))) {
          const taxService = services.find((s: { pipeline_type?: string; price?: string }) =>
            s.pipeline_type === "Tax Return" &&
            s.price &&
            /inclus[ao]|included|€?\s*0|\$?\s*0/i.test(s.price)
          )
          if (taxService) {
            taxReturnIncludedInOffer = true
          }
        }
      }
    }

    for (const tc of taxChecks) {
      const fieldValue = String(submitted[tc.field] || "").toLowerCase()
      if (fieldValue === "no") {
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
            const isBundled = taxReturnIncludedInOffer && tc.year === previousYear
            const { error: trErr } = await supabaseAdmin
              .from("tax_returns")
              .insert({
                account_id,
                company_name,
                return_type: returnType,
                tax_year: tc.year,
                deadline,
                status: isBundled ? "Paid - Not Started" : "Not Invoiced",
                ...(isBundled ? { paid: true } : {}),
              })
            if (trErr) {
              result.steps.push(step(`tax_return:${tc.year}`, "error", trErr.message))
            } else {
              const note = isBundled ? "Created as Paid (bundled in offer)" : `Created (deadline: ${deadline})`
              result.steps.push(step(`tax_return:${tc.year}`, "ok", note))
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
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
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

  // ─── 5b. SET RENEWAL DATES ───
  if (account_id) {
    try {
      const renewalUpdates: Record<string, unknown> = {}
      const currentYear = new Date().getFullYear()

      // CMRA renewal = Dec 31 current year (lease expiry)
      renewalUpdates.cmra_renewal_date = `${currentYear}-12-31`

      // Annual Report due date — based on state
      const stateUpper = (state_of_formation || "").toUpperCase().replace("NEW MEXICO", "NM").replace("WYOMING", "WY").replace("FLORIDA", "FL").replace("DELAWARE", "DE")
      const formationDate = String(submitted.formation_date || "")

      if (stateUpper === "NM") {
        // New Mexico: NO annual report
        // Don't set annual_report_due_date
      } else if (stateUpper === "FL") {
        // Florida: May 1 every year
        renewalUpdates.annual_report_due_date = `${currentYear + 1}-05-01`
      } else if (stateUpper === "DE") {
        // Delaware: June 1 for LLCs, March 1 for Corps
        renewalUpdates.annual_report_due_date = `${currentYear + 1}-06-01`
      } else if (stateUpper === "WY" && formationDate) {
        // Wyoming: 1st day of anniversary month
        const month = formationDate.slice(5, 7) // MM from YYYY-MM-DD
        renewalUpdates.annual_report_due_date = `${currentYear + 1}-${month}-01`
      }

      renewalUpdates.updated_at = new Date().toISOString()

      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
      await supabaseAdmin
        .from("accounts")
        .update(renewalUpdates)
        .eq("id", account_id)

      const datesList = Object.entries(renewalUpdates)
        .filter(([k]) => k.endsWith("_date") && k !== "updated_at")
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")

      result.steps.push(step("renewal_dates", "ok", datesList || "Set (NM has no AR)"))
    } catch (e) {
      result.steps.push(step("renewal_dates", "error", e instanceof Error ? e.message : String(e)))
    }
    await updateJobProgress(job.id, result)
  }

  // ─── 6. LEAD CONVERSION — SKIPPED (now happens at payment in whop webhook / check-wire-payments) ───
  result.steps.push(step("lead_converted", "skipped", "Moved to payment confirmation (Change 1.1)"))

  // ─── 7. MARK FORM AS REVIEWED ───
  if (p.submission_id) {
    try {
      const { error: formErr } = await supabaseAdmin
        .from("onboarding_submissions")
        .update({
          status: "reviewed",
          reviewed_at: now,
          reviewed_by: p.source === "portal_wizard" ? "portal_auto" : "claude",
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
  } else {
    result.steps.push(step("form_reviewed", "skipped", "No submission_id"))
  }

  // ─── 8. UPDATE SUBMISSION WITH ACCOUNT/CONTACT IDs ───
  if (p.submission_id) {
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
  }

  // ─── 9. PORTAL TIER — NO AUTO-UPGRADE (Tier Model B, SOP v7.2) ───
  // Tier remains at "onboarding" after the wizard is submitted. Antonio
  // reviews the submission + documents in the CRM and explicitly promotes
  // the client to "active" via the Reconcile Portal Tier button (P3.4 #2).
  // This replaces the previous auto-upgrade here which conflicted with
  // activate-service's reconciliation and caused the tier ping-pong bug
  // documented in dev_task 3d6800c8 (Luca Gallacci live QA 2026-04-18).
  result.steps.push(step("tier_upgrade", "skipped", "Stays at onboarding pending Antonio's review (Tier Model B)"))

  // ─── 10. PORTAL NOTIFICATION TO CONTACT ───
  if (contact_id) {
    try {
      const { createPortalNotification } = await import("@/lib/portal/notifications")
      await createPortalNotification({
        contact_id,
        account_id: account_id || undefined,
        type: "service",
        title: "We received your onboarding data",
        body: company_name
          ? `Thanks — we've received everything for ${company_name}. Our team is reviewing your submission and will activate your services shortly (typically 1–2 business days).`
          : "Thanks — we've received your onboarding data. Our team is reviewing your submission and will activate your services shortly (typically 1–2 business days).",
        link: "/portal",
      })
      result.steps.push(step("portal_notification", "ok", "Contact notified in portal"))
    } catch (e) {
      result.steps.push(step("portal_notification", "error", e instanceof Error ? e.message : String(e)))
    }
  }

  // ─── 11. ENQUEUE WELCOME PACKAGE (banking forms, Drive search, email draft) ───
  // OA + Lease were just created above — welcome_package_prepare is idempotent
  // and will skip them, only creating Relay/Payset forms + email draft + review task
  if (account_id) {
    try {
      const { data: acctWP } = await supabaseAdmin
        .from("accounts")
        .select("welcome_package_status, ein_number")
        .eq("id", account_id)
        .single()

      if (acctWP?.welcome_package_status) {
        result.steps.push(step("welcome_package", "skipped", `Already ${acctWP.welcome_package_status}`))
      } else if (!acctWP?.ein_number) {
        result.steps.push(step("welcome_package", "skipped", "No EIN yet — will be triggered when formation reaches Post-Formation stage"))
      } else {
        const { enqueueJob } = await import("@/lib/jobs/queue")
        await enqueueJob({
          job_type: "welcome_package_prepare",
          payload: { account_id },
          priority: 5,
        })
        result.steps.push(step("welcome_package", "ok", "Job enqueued (Relay, Payset, email draft, review task)"))
      }
    } catch (e) {
      result.steps.push(step("welcome_package", "error", e instanceof Error ? e.message : String(e)))
    }
    await updateJobProgress(job.id, result)
  }

  // ─── 12. STAFF NOTIFICATION (email + task) ───
  try {
    const clientName = submitted.owner_first_name
      ? `${submitted.owner_first_name} ${submitted.owner_last_name || ""}`
      : token

    // Create task for staff review
    const existingTaskTitle = `Portal Wizard: Onboarding data submitted — ${clientName}${company_name ? ` (${company_name})` : ""}`
    const { data: existingTask } = await supabaseAdmin
      .from("tasks")
      .select("id")
      .eq("task_title", existingTaskTitle)
      .maybeSingle()

    if (!existingTask) {
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
      await supabaseAdmin.from("tasks").insert({
        task_title: existingTaskTitle,
        description: [
          `Auto-chain completed for ${p.entity_type || "SMLLC"} onboarding via ${p.source === "portal_wizard" ? "portal wizard" : "MCP review"}.`,
          token ? `Review: onboarding_form_review(token="${token}")` : "",
          account_id ? `Account: ${account_id}` : "No account created (check errors)",
        ].filter(Boolean).join("\n"),
        status: "To Do",
        priority: "High",
        category: "Client Response",
        assigned_to: "Luca",
        account_id: account_id || null,
        created_by: "Claude",
      })
    }

    // Email notification to support
    const { gmailPost } = await import("@/lib/gmail")
    const subject = `Onboarding Auto-Chain: ${clientName}${company_name ? ` — ${company_name}` : ""}`
    const okSteps = result.steps.filter(s => s.status === "ok").length
    const errSteps = result.steps.filter(s => s.status === "error").length
    const body = [
      `Auto-chain completed: ${okSteps} ok, ${errSteps} errors.`,
      `Source: ${p.source === "portal_wizard" ? "Portal Wizard" : "MCP Magic Button"}`,
      `Token: ${token}`,
      account_id ? `Account ID: ${account_id}` : "No account created",
      "",
      "Steps:",
      ...result.steps.map(s => `  ${s.status === "ok" ? "✓" : s.status === "error" ? "✗" : "○"} ${s.name}: ${s.detail || ""}`),
    ].join("\n")

    const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
    const mimeHeaders = [
      "From: Tony Durante LLC <support@tonydurante.us>",
      "To: support@tonydurante.us",
      `Subject: ${encodedSubject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
    ]
    const rawEmail = [...mimeHeaders, "", Buffer.from(body).toString("base64")].join("\r\n")
    await gmailPost("/messages/send", { raw: Buffer.from(rawEmail).toString("base64url") })

    result.steps.push(step("staff_notification", "ok", `Task + email sent for ${clientName}`))
  } catch (e) {
    result.steps.push(step("staff_notification", "error", e instanceof Error ? e.message : String(e)))
  }

  // Summary
  const okCount = result.steps.filter(s => s.status === "ok").length
  const errCount = result.steps.filter(s => s.status === "error").length
  const skipCount = result.steps.filter(s => s.status === "skipped").length
  result.summary = `${okCount} ok, ${errCount} errors, ${skipCount} skipped`

  return result
}
