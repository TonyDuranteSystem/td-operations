/**
 * Job Handler: tax_return_intake
 *
 * Processes company_info wizard submissions for standalone BUSINESS Tax Return clients.
 * Creates a real account from the submitted company data, links it to the contact,
 * backfills payments/SD, creates tax_returns row, and advances the SD.
 *
 * Steps (critical 1-8, non-critical 9-11):
 *   1. Validate submitted data
 *   2. Update contact with wizard data
 *   3. Create account (via shared utility)
 *   4. Update submission + job with account_id
 *   5. Backfill Tax Return SD account_id
 *   6. Create tax_returns row
 *   7. Advance SD: "Company Data Pending" → "Paid - Awaiting Data"
 *   8. (critical steps end — failures above stop the handler)
 *   9. Drive folder + document upload (non-critical)
 *  10. Portal tier upgrade (non-critical)
 *  11. Notification (non-critical)
 *
 * Triggered by: wizard-submit when wizard_type='company_info'
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { createAccountFromWizard } from "@/lib/account-from-wizard"
import { advanceServiceDelivery } from "@/lib/service-delivery"
import { updateJobProgress, type Job, type JobResult } from "../queue"

interface TaxReturnIntakePayload {
  token: string
  submission_id: string | null
  account_id: string | null // Always null at intake — account doesn't exist yet
  contact_id: string | null
  company_name: string
  state_of_formation: string
  entity_type: string // "SMLLC" or "MMLLC"
  submitted_data: Record<string, unknown>
  upload_paths: string[] | null
  source?: "portal_wizard" | string
}

function step(name: string, status: "ok" | "error" | "skipped", detail?: string) {
  return { name, status, detail, timestamp: new Date().toISOString() }
}

export async function handleTaxReturnIntake(job: Job): Promise<JobResult> {
  const p = job.payload as unknown as TaxReturnIntakePayload
  const result: JobResult = { steps: [] }

  const { contact_id, token } = p
  const submitted = p.submitted_data || {}
  const companyName = String(submitted.company_name || p.company_name || "")
  const stateOfFormation = String(submitted.state_of_formation || p.state_of_formation || "")
  const ein = submitted.ein ? String(submitted.ein) : null
  const formationDate = submitted.formation_date ? String(submitted.formation_date) : null

  // ─── 1. VALIDATE ───
  if (!contact_id) {
    result.steps.push(step("validation", "error", "Missing contact_id"))
    result.summary = "Validation failed: no contact_id"
    return result
  }
  if (!companyName) {
    result.steps.push(step("validation", "error", "Missing company_name in submitted data"))
    result.summary = "Validation failed: no company_name"
    return result
  }
  result.steps.push(step("validation", "ok", `${companyName} — contact ${contact_id}`))
  await updateJobProgress(job.id, result)

  // ─── 2. UPDATE CONTACT WITH WIZARD DATA ───
  try {
    const contactUpdates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (submitted.owner_first_name) contactUpdates.first_name = submitted.owner_first_name
    if (submitted.owner_last_name) contactUpdates.last_name = submitted.owner_last_name
    if (submitted.owner_first_name && submitted.owner_last_name) {
      contactUpdates.full_name = `${submitted.owner_first_name} ${submitted.owner_last_name}`
    }
    if (submitted.owner_dob) contactUpdates.date_of_birth = submitted.owner_dob
    if (submitted.owner_nationality) contactUpdates.citizenship = submitted.owner_nationality
    if (submitted.owner_street) {
      contactUpdates.address = [
        submitted.owner_street,
        submitted.owner_city,
        submitted.owner_state_province,
        submitted.owner_zip,
        submitted.owner_country,
      ].filter(Boolean).join(", ")
    }

    const fieldCount = Object.keys(contactUpdates).filter(k => k !== "updated_at").length
    if (fieldCount > 0) {
      await supabaseAdmin.from("contacts").update(contactUpdates).eq("id", contact_id)
      result.steps.push(step("contact_update", "ok", `Updated ${fieldCount} fields`))
    } else {
      result.steps.push(step("contact_update", "skipped", "No contact fields in submission"))
    }
  } catch (e) {
    result.steps.push(step("contact_update", "skipped", `Non-critical: ${e instanceof Error ? e.message : String(e)}`))
  }
  await updateJobProgress(job.id, result)

  // ─── 3. CREATE ACCOUNT (CRITICAL) ───
  let accountId: string | null = null
  try {
    const acctResult = await createAccountFromWizard({
      contactId: contact_id,
      companyName,
      entityType: p.entity_type || "SMLLC",
      stateOfFormation,
      ein,
      formationDate,
      accountType: "One-Time",
    })

    if (acctResult.error || !acctResult.accountId) {
      result.steps.push(step("account_create", "error", acctResult.error || "No account_id returned"))
      await createFailureTask(contact_id, companyName, token, "Account creation failed", acctResult.error)
      result.summary = `CRITICAL: Account creation failed — ${acctResult.error}`
      return result
    }

    accountId = acctResult.accountId
    result.steps.push(step("account_create", acctResult.created ? "ok" : "skipped",
      acctResult.created
        ? `${companyName} (${p.entity_type}) → linked to contact`
        : `Already exists: ${accountId}`
    ))

    if (acctResult.backfilled.invoices > 0 || acctResult.backfilled.payments > 0) {
      result.steps.push(step("payment_backfill", "ok",
        `Backfilled account_id on ${acctResult.backfilled.invoices} invoices, ${acctResult.backfilled.payments} payments`
      ))
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    result.steps.push(step("account_create", "error", msg))
    await createFailureTask(contact_id, companyName, token, "Account creation threw", msg)
    result.summary = `CRITICAL: Account creation threw — ${msg}`
    return result
  }
  await updateJobProgress(job.id, result)

  // ─── 4. UPDATE SUBMISSION + JOB WITH ACCOUNT_ID ───
  if (p.submission_id) {
    await supabaseAdmin
      .from("company_info_submissions")
      .update({ account_id: accountId })
      .eq("id", p.submission_id)
  }
  await supabaseAdmin
    .from("job_queue")
    .update({ account_id: accountId })
    .eq("id", job.id)

  // ─── 5. BACKFILL TAX RETURN SD ACCOUNT_ID (CRITICAL) ───
  let taxReturnSdId: string | null = null
  try {
    const { data: sd } = await supabaseAdmin
      .from("service_deliveries")
      .select("id, stage")
      .eq("service_type", "Tax Return")
      .eq("contact_id", contact_id)
      .eq("status", "active")
      .eq("stage", "Company Data Pending")
      .is("account_id", null)
      .limit(1)
      .maybeSingle()

    if (!sd) {
      result.steps.push(step("sd_backfill", "error", "No Tax Return SD at 'Company Data Pending' with null account_id"))
      await createFailureTask(contact_id, companyName, token, "SD backfill failed", "No matching SD found")
      result.summary = "CRITICAL: No Tax Return SD found for backfill"
      return result
    }

    taxReturnSdId = sd.id
    await supabaseAdmin
      .from("service_deliveries")
      .update({ account_id: accountId, updated_at: new Date().toISOString() })
      .eq("id", sd.id)

    result.steps.push(step("sd_backfill", "ok", `SD ${sd.id.slice(0, 8)} → account ${accountId!.slice(0, 8)}`))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    result.steps.push(step("sd_backfill", "error", msg))
    await createFailureTask(contact_id, companyName, token, "SD backfill threw", msg)
    result.summary = `CRITICAL: SD backfill threw — ${msg}`
    return result
  }
  await updateJobProgress(job.id, result)

  // ─── 6. CREATE TAX_RETURNS ROW (CRITICAL) ───
  try {
    const currentYear = new Date().getFullYear()
    const { data: existingTR } = await supabaseAdmin
      .from("tax_returns")
      .select("id")
      .eq("account_id", accountId!)
      .eq("tax_year", currentYear)
      .maybeSingle()

    if (existingTR) {
      result.steps.push(step("tax_returns_create", "skipped", `Already exists for ${currentYear}: ${existingTR.id}`))
    } else {
      const { data: newTR, error: trErr } = await supabaseAdmin
        .from("tax_returns")
        .insert({
          account_id: accountId!,
          company_name: companyName,
          return_type: (p.entity_type || "SMLLC") as never,
          deadline: `${currentYear + 1}-04-15`,
          tax_year: currentYear,
          data_received: false,
          paid: true,
        })
        .select("id")
        .single()

      if (trErr || !newTR) {
        result.steps.push(step("tax_returns_create", "error", trErr?.message || "Insert failed"))
        await createFailureTask(contact_id, companyName, token, "tax_returns creation failed", trErr?.message)
        result.summary = `CRITICAL: tax_returns creation failed — ${trErr?.message}`
        return result
      }
      result.steps.push(step("tax_returns_create", "ok", `tax_returns ${newTR.id.slice(0, 8)} for ${currentYear}`))
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    result.steps.push(step("tax_returns_create", "error", msg))
    await createFailureTask(contact_id, companyName, token, "tax_returns creation threw", msg)
    result.summary = `CRITICAL: tax_returns creation threw — ${msg}`
    return result
  }
  await updateJobProgress(job.id, result)

  // ─── 7. ADVANCE SD: "Company Data Pending" → "Paid - Awaiting Data" (CRITICAL) ───
  try {
    const advResult = await advanceServiceDelivery({
      delivery_id: taxReturnSdId!,
      target_stage: "Paid - Awaiting Data",
      notes: `Company info received from ${companyName}. Account created.`,
      actor: "tax_return_intake",
      skip_tasks: true,
    })

    if (!advResult.success) {
      result.steps.push(step("sd_advance", "error", advResult.error || "Advancement failed"))
      await createFailureTask(contact_id, companyName, token, "SD advance failed", advResult.error)
      result.summary = `CRITICAL: SD advance failed — ${advResult.error}`
      return result
    }
    result.steps.push(step("sd_advance", "ok", `${advResult.from_stage} → ${advResult.to_stage}`))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    result.steps.push(step("sd_advance", "error", msg))
    await createFailureTask(contact_id, companyName, token, "SD advance threw", msg)
    result.summary = `CRITICAL: SD advance threw — ${msg}`
    return result
  }
  await updateJobProgress(job.id, result)

  // ═══ CRITICAL STEPS COMPLETE ═══
  // Steps below are non-critical — log and continue on failure.

  // ─── 9. DRIVE FOLDER + DOCUMENT UPLOAD (NON-CRITICAL) ───
  try {
    const { ensureCompanyFolder } = await import("@/lib/drive-folder-utils")
    const folderResult = await ensureCompanyFolder(accountId!, companyName, stateOfFormation)
    result.steps.push(step("drive_folder", folderResult.created ? "ok" : "skipped",
      folderResult.created ? `Created: ${folderResult.folderId}` : `Already exists: ${folderResult.folderId}`
    ))

    // Upload wizard files if any
    const uploads = p.upload_paths || []
    if (uploads.length > 0 && folderResult.folderId) {
      const { uploadBinaryToDrive } = await import("@/lib/google-drive")
      const { supabaseAdmin: sbAdmin } = await import("@/lib/supabase-admin")
      for (const path of uploads) {
        try {
          const { data: fileData } = await sbAdmin.storage.from("onboarding-uploads").download(path)
          if (fileData) {
            const fileName = path.split("/").pop() || path
            const buf = Buffer.from(await fileData.arrayBuffer())
            const driveResult = await uploadBinaryToDrive(fileName, buf, "application/octet-stream", folderResult.folderId) as { id: string; name: string }
            result.steps.push(step(`doc_copy:${fileName}`, "ok", driveResult.id))
          }
        } catch (uploadErr) {
          result.steps.push(step(`doc_copy:${path}`, "skipped", `Non-critical: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`))
        }
      }
    }
  } catch (e) {
    result.steps.push(step("drive_folder", "skipped", `Non-critical: ${e instanceof Error ? e.message : String(e)}`))
  }
  await updateJobProgress(job.id, result)

  // ─── 10. PORTAL TIER UPGRADE (NON-CRITICAL) ───
  try {
    await supabaseAdmin
      .from("accounts")
      .update({ portal_tier: "active", updated_at: new Date().toISOString() })
      .eq("id", accountId!)

    result.steps.push(step("portal_tier", "ok", "Upgraded to active"))
  } catch (e) {
    result.steps.push(step("portal_tier", "skipped", `Non-critical: ${e instanceof Error ? e.message : String(e)}`))
  }

  // ─── 11. NOTIFICATION (NON-CRITICAL) ───
  try {
    const { createPortalNotification } = await import("@/lib/portal/notifications")
    await createPortalNotification({
      account_id: accountId!,
      contact_id: contact_id,
      type: "info",
      title: "Company Information Received",
      body: "Your company information has been processed. You can now complete your Tax Return questionnaire.",
    })
    result.steps.push(step("notification", "ok", "Portal notification sent"))
  } catch (e) {
    result.steps.push(step("notification", "skipped", `Non-critical: ${e instanceof Error ? e.message : String(e)}`))
  }

  result.summary = `Tax Return intake complete for ${companyName}. Account created, SD advanced to Paid - Awaiting Data.`
  return result
}

// ─── Helper: Create CRM task on critical failure ───
async function createFailureTask(
  contactId: string,
  companyName: string,
  token: string,
  failStep: string,
  detail?: string | null,
) {
  try {
    await supabaseAdmin.from("tasks").insert({
      task_title: `Tax Return intake failed — ${companyName || token}`,
      description: [
        `Critical step failed: ${failStep}`,
        detail ? `Detail: ${detail}` : "",
        "",
        `Contact: ${contactId}`,
        `Token: ${token}`,
        "Review company_info_submissions and retry manually.",
      ].filter(Boolean).join("\n"),
      status: "To Do",
      priority: "High",
      category: "Client Response",
      assigned_to: "Luca",
      created_by: "Claude",
    })
  } catch {
    // Non-blocking — task creation failure shouldn't mask the original error
  }
}
