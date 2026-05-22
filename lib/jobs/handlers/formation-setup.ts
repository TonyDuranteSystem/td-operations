/**
 * Job Handler: formation_setup
 *
 * Auto-chain for formation wizard submissions (Antonio's architectural model,
 * 2026-05-03/04). After this handler runs, the formation client has:
 * - Updated contact (DOB, address, passport_on_file)
 * - Contact-level Drive folder (Contacts/{Name}/) with passport uploaded
 * - "Company Formation" Service Delivery on the contact (no account_id)
 * - Email to support@, Luca WhatsApp task, portal notification
 *
 * What this handler does NOT do (deferred to Articles arrival):
 * - Create the CRM account
 * - Write members rows (data stays on formation_submissions.submitted_data)
 * - Upload additional MMLLC member passports to Drive
 * - Migrate the contact Drive folder to a company folder
 *
 * The materialization at Articles upload (PR 3) reads formation_submissions
 * to create account + account_contacts + members + Drive migration + SS-4.
 *
 * Triggered by:
 * 1. Portal wizard-submit (source: 'portal_wizard') — primary path
 * 2. MCP formation_form_review (source: undefined) — legacy admin path
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { createSD } from "@/lib/operations/service-delivery"
import { updateJobProgress, type Job, type JobResult } from "../queue"
import { validateFormationData } from "../validation"

interface FormationPayload {
  token: string
  submission_id: string | null
  contact_id: string | null
  lead_id: string | null
  submitted_data: Record<string, unknown>
  source?: "portal_wizard" | string
}

function step(name: string, status: "ok" | "error" | "skipped", detail?: string) {
  return { name, status, detail, timestamp: new Date().toISOString() }
}

export async function handleFormationSetup(job: Job): Promise<JobResult> {
  const p = job.payload as unknown as FormationPayload
  const result: JobResult = { steps: [] }
  const now = new Date().toISOString()
  const submitted = p.submitted_data || {}

  // ─── 0. VALIDATE WIZARD DATA ───
  const validation = validateFormationData(submitted)
  if (!validation.valid) {
    const errDetail = validation.errors.map(e => `${e.field}: ${e.message}`).join("; ")
    result.steps.push(step("validation", "error", errDetail))
    result.summary = `Validation failed: ${validation.errors.length} error(s)`
    result.ok = false
    return result
  }
  result.steps.push(step("validation", "ok", "All checks passed"))

  // ─── 1. UPDATE CONTACT WITH SUBMITTED DATA ───
  if (p.contact_id) {
    try {
      const contactUpdates: Record<string, unknown> = {
        updated_at: now,
      }

      if (submitted.owner_first_name) contactUpdates.first_name = submitted.owner_first_name
      if (submitted.owner_last_name) contactUpdates.last_name = submitted.owner_last_name
      if (submitted.owner_email) contactUpdates.email = submitted.owner_email
      if (submitted.owner_phone) contactUpdates.phone = submitted.owner_phone
      if (submitted.owner_nationality) contactUpdates.citizenship = submitted.owner_nationality
      if (submitted.owner_dob) contactUpdates.date_of_birth = submitted.owner_dob

      // Dual-write address: structured fields (primary) + residency concat
      // (legacy readers). Same pattern as onboarding-setup / tax-return-intake.
      if (submitted.owner_street) contactUpdates.address_line1 = String(submitted.owner_street).trim()
      if (submitted.owner_city) contactUpdates.address_city = String(submitted.owner_city).trim()
      if (submitted.owner_state_province) contactUpdates.address_state = String(submitted.owner_state_province).trim()
      if (submitted.owner_zip) contactUpdates.address_zip = String(submitted.owner_zip).trim()
      if (submitted.owner_country) contactUpdates.address_country = String(submitted.owner_country).trim()
      const addrParts = [
        submitted.owner_street,
        submitted.owner_city,
        submitted.owner_state_province,
        submitted.owner_zip,
        submitted.owner_country,
      ].filter(Boolean).map(String).map(s => s.trim())
      if (addrParts.length > 1) {
        contactUpdates.residency = addrParts.join(', ')
      } else if (submitted.owner_country) {
        contactUpdates.residency = String(submitted.owner_country).trim()
      }

      // Mark passport as on file if uploaded
      if (submitted.passport_owner) {
        contactUpdates.passport_on_file = true
      }

      const fieldCount = Object.keys(contactUpdates).filter(k => k !== "updated_at").length
      if (fieldCount > 0) {
        // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
        const { error: upErr } = await supabaseAdmin
          .from("contacts")
          .update(contactUpdates)
          .eq("id", p.contact_id)

        if (upErr) {
          result.steps.push(step("contact_update", "error", upErr.message))
        } else {
          result.steps.push(step("contact_update", "ok", `${fieldCount} fields updated`))
        }
      } else {
        result.steps.push(step("contact_update", "skipped", "No contact fields to update"))
      }
    } catch (e) {
      result.steps.push(step("contact_update", "error", e instanceof Error ? e.message : String(e)))
    }
  } else {
    result.steps.push(step("contact_update", "skipped", "No contact_id"))
  }

  await updateJobProgress(job.id, result)

  // ─── 2. LEAD CONVERSION — SKIPPED (now happens at payment in whop webhook / check-wire-payments) ───
  result.steps.push(step("lead_converted", "skipped", "Moved to payment confirmation (Change 1.1)"))

  // ─── 2a. NO ACCOUNT CREATION AT WIZARD SUBMIT (Antonio's model, 2026-05-03/04) ───
  // The account is created when Articles of Organization arrive in Drive.
  // Until then, all data attaches to the contact, and member info stays on
  // formation_submissions.submitted_data. The materialization at Articles
  // upload reads the submission and creates account + account_contacts +
  // members + Drive migration + SS-4 fire in one atomic helper.
  //
  // See sysdoc 'ops-2026-05-03-formation-architecture-decision-and-plan'.
  const accountId: string | null = null
  result.steps.push(step(
    "account_create",
    "skipped",
    "Formation account deferred — created when Articles of Organization arrive in Drive",
  ))

  // ─── 2a.1. DRIVE FOLDER + PASSPORT PROCESSING ───
  // Phase 1: Create contact-level Drive folder (Contacts/{Name}/)
  // Documents will migrate to company folder when LLC name is selected (Phase 2)
  let contactDriveFolderId: string | null = null
  if (p.contact_id) {
    try {
      const { ensureContactFolder } = await import("@/lib/drive-folder-utils")
      const contactName = [submitted.owner_first_name, submitted.owner_last_name].filter(Boolean).join(" ") || p.token
      const folderResult = await ensureContactFolder(p.contact_id, contactName)
      contactDriveFolderId = folderResult.folderId

      if (folderResult.created) {
        result.steps.push(step("drive_folder", "ok", `Created: Contacts/${contactName}/`))
      } else {
        result.steps.push(step("drive_folder", "skipped", "Already exists"))
      }

      // Copy passport from Supabase Storage to Drive
      const passportPath = submitted.passport_owner as string | undefined
      if (passportPath && contactDriveFolderId) {
        try {
          const contactsSubfolder = folderResult.subfolders["2. Contacts"]
          if (contactsSubfolder) {
            const cleanPath = passportPath.replace(/^\/+/, "")
            const { data: blob, error: dlErr } = await supabaseAdmin.storage
              .from("onboarding-uploads")
              .download(cleanPath)

            if (dlErr || !blob) {
              result.steps.push(step("passport_copy", "error", dlErr?.message || "Download failed"))
            } else {
              const { uploadBinaryToDrive } = await import("@/lib/google-drive")
              const fileName = cleanPath.split("/").pop() || "passport.pdf"
              const buffer = Buffer.from(await blob.arrayBuffer())
              const mimeType = blob.type || "application/octet-stream"

              const driveFile = await uploadBinaryToDrive(fileName, buffer, mimeType, contactsSubfolder) as { id: string; name: string }
              result.steps.push(step("passport_copy", "ok", `Uploaded to Drive: ${driveFile.id}`))

              // OCR + MRZ extraction — shared helper writes passport_number /
              // passport_expiry_date / date_of_birth to the contact and creates
              // a manual-entry task for unsupported formats (HEIC).
              const { extractAndStorePassportData } = await import("@/lib/jobs/passport-writeback")
              const passportResult = await extractAndStorePassportData({
                contact_id: p.contact_id!,
                drive_file_id: driveFile.id,
                mime_type: mimeType,
                skip_dob: !!submitted.owner_dob,
                contact_name: [submitted.owner_first_name, submitted.owner_last_name].filter(Boolean).join(" ") || p.token,
                account_id: accountId,
              })
              result.steps.push(step("passport_ocr", passportResult.status, passportResult.detail))

              // Create document record
              await supabaseAdmin.from("documents").insert({
                file_name: fileName,
                drive_file_id: driveFile.id,
                drive_link: `https://drive.google.com/file/d/${driveFile.id}/view`,
                document_type_name: "Passport",
                category: 2,
                category_name: "Contacts",
                status: "classified",
                contact_id: p.contact_id,
                account_id: accountId,
                portal_visible: true,
              })
              result.steps.push(step("passport_doc_record", "ok", "Document record created"))
            }
          } else {
            result.steps.push(step("passport_copy", "error", "No '2. Contacts' subfolder found"))
          }
        } catch (passErr) {
          result.steps.push(step("passport_copy", "error", passErr instanceof Error ? passErr.message : String(passErr)))
        }
      } else if (!passportPath) {
        result.steps.push(step("passport_copy", "skipped", "No passport uploaded"))
      }
    } catch (driveErr) {
      result.steps.push(step("drive_folder", "error", driveErr instanceof Error ? driveErr.message : String(driveErr)))
    }
    await updateJobProgress(job.id, result)
  }

  // ─── 2b. MMLLC MEMBER PROCESSING DEFERRED (Antonio's model, 2026-05-03/04) ───
  // Additional MMLLC members are NOT processed here. Their data lives on
  // formation_submissions.submitted_data (member_first_name, member_email,
  // ownership_pct, etc.) and their passports stay in Supabase storage under
  // formation_submissions.upload_paths.
  //
  // The materialization at Articles upload (PR 3) reads the submission and:
  //   - creates a contact for each additional member (find-or-create by email)
  //   - inserts members rows on the new account
  //   - upserts account_contacts (Member role)
  //   - copies each member passport from storage → Drive
  //   - creates documents rows
  //
  // For SMLLC: nothing to defer — only the owner exists. The owner's contact
  // updates + passport + members row (if any) are handled at materialization.

  // ─── 2c. CREATE SERVICE DELIVERY (Company Formation pipeline, Stage 1: Data Collection) ───
  try {
    const sdContactId = p.contact_id
    if (sdContactId) {
      // Check if SD already exists for this contact
      const { data: existingSd } = await supabaseAdmin
        .from("service_deliveries")
        .select("id")
        .eq("contact_id", sdContactId)
        .eq("service_type", "Company Formation")
        .eq("status", "active")
        .limit(1)

      if (existingSd && existingSd.length > 0) {
        result.steps.push(step("service_delivery", "skipped", `Already exists: ${existingSd[0].id}`))
      } else {
        // SD is contact-only at wizard submit per Antonio's model. The first
        // candidate LLC name is appended to the SD name purely for human
        // readability in the CRM — it is NOT a commitment to that name. The
        // chosen name is recorded separately on wizard data via the LLC Name
        // Selection card; the SD's service_name is updated when the company
        // is materialized at Articles upload.
        const llcCandidate = String(submitted.llc_name_1 || "").trim()
        const sdName = llcCandidate ? `Company Formation - ${llcCandidate}` : "Company Formation"
        try {
          const sd = await createSD({
            service_type: "Company Formation",
            service_name: sdName,
            // Antonio's model: SD attaches to the buyer (contact) until/unless the company materializes.
            contact_id: sdContactId,
            account_id: null,
            target_stage: "Data Collection",
            target_stage_order: 1,
            start_date: now.slice(0, 10),
          })
          result.steps.push(step("service_delivery", "ok", `SD created: ${sd.id} (Data Collection, contact-scoped)`))
        } catch (e) {
          result.steps.push(step("service_delivery", "error", e instanceof Error ? e.message : String(e)))
        }
      }
    } else {
      result.steps.push(step("service_delivery", "skipped", "No contact_id available"))
    }
  } catch (e) {
    result.steps.push(step("service_delivery", "error", e instanceof Error ? e.message : String(e)))
  }

  await updateJobProgress(job.id, result)

  // ─── 3. MARK FORM AS REVIEWED ───
  if (!p.submission_id) {
    result.steps.push(step("form_reviewed", "skipped", "No submission_id"))
  } else {
  try {
    const { error: formErr } = await supabaseAdmin
      .from("formation_submissions")
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
  } // end submission_id check

  await updateJobProgress(job.id, result)

  // ─── 4. EMAIL NOTIFICATION TO SUPPORT ───
  try {
    const clientName = submitted.owner_first_name
      ? `${submitted.owner_first_name} ${submitted.owner_last_name || ""}`
      : p.token

    const { gmailPost } = await import("@/lib/gmail")

    const subject = `Formation Form Completed: ${clientName}`
    const body = [
      `Client ${clientName} has completed the formation data collection form.`,
      ``,
      `Token: ${p.token}`,
      `Email: ${submitted.owner_email || "N/A"}`,
      `LLC Names: ${submitted.llc_name_1 || "N/A"}`,
      ``,
      `Review: formation_form_review(token="${p.token}")`,
      `Admin Preview: ${APP_BASE_URL}/formation-form/${p.token}?preview=td`,
    ].join("\n")

    const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
    const mimeHeaders = [
      `From: Tony Durante LLC <support@tonydurante.us>`,
      `To: support@tonydurante.us`,
      `Subject: ${encodedSubject}`,
      "MIME-Version: 1.0",
      `Content-Type: text/plain; charset=utf-8`,
      "Content-Transfer-Encoding: base64",
    ]
    const rawEmail = [...mimeHeaders, "", Buffer.from(body).toString("base64")].join("\r\n")
    const encodedRaw = Buffer.from(rawEmail).toString("base64url")

    await gmailPost("/messages/send", { raw: encodedRaw })
    result.steps.push(step("email_notification", "ok", `Notified support@ about ${clientName}`))
  } catch (e) {
    result.steps.push(step("email_notification", "error", e instanceof Error ? e.message : String(e)))
  }

  // ─── 5. CRM TASK FOR LUCA (WHATSAPP FOLLOW-UP) ───
  try {
    const clientName = submitted.owner_first_name
      ? `${submitted.owner_first_name} ${submitted.owner_last_name || ""}`
      : p.token

    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
    const { error: taskErr } = await supabaseAdmin.from("tasks").insert({
      task_title: `WhatsApp follow-up: ${clientName} (formation form completed)`,
      description: [
        `Il cliente ${clientName} ha completato il formation form.`,
        ``,
        `Email: ${submitted.owner_email || "N/A"}`,
        `Phone: ${submitted.owner_phone || "N/A"}`,
        `LLC Name: ${submitted.llc_name_1 || "N/A"}`,
        ``,
        `Azione: Contattare via WhatsApp per confermare ricezione e prossimi step.`,
        `Review form: formation_form_review(token="${p.token}")`,
      ].join("\n"),
      assigned_to: "Luca",
      priority: "High",
      category: "Formation",
      status: "To Do",
      ...(accountId ? { account_id: accountId } : {}),
    })

    if (taskErr) {
      result.steps.push(step("luca_whatsapp_task", "error", taskErr.message))
    } else {
      result.steps.push(step("luca_whatsapp_task", "ok", `WhatsApp task created for Luca`))
    }
  } catch (e) {
    result.steps.push(step("luca_whatsapp_task", "error", e instanceof Error ? e.message : String(e)))
  }

  // ─── 6. PORTAL NOTIFICATION TO CONTACT ───
  if (p.contact_id) {
    try {
      const { createPortalNotification } = await import("@/lib/portal/notifications")
      const llcName = String(submitted.llc_name_1 || "your LLC")
      await createPortalNotification({
        contact_id: p.contact_id,
        account_id: accountId || undefined,
        type: "service",
        title: "Formation data received!",
        body: `We received your information for ${llcName}. Our team will verify and begin the formation process.`,
        link: "/portal/services",
      })
      result.steps.push(step("portal_notification", "ok", "Contact notified in portal"))
    } catch (e) {
      result.steps.push(step("portal_notification", "error", e instanceof Error ? e.message : String(e)))
    }
  }

  // ─── 7. NOTIFICATION CENTER: staff action card (contact-scoped, no client-chat write) ───
  if (p.contact_id) {
    try {
      const { emitActionNeeded } = await import("@/lib/notifications/act-event")
      await emitActionNeeded({
        event: "formation_wizard_submitted",
        contact_id: p.contact_id,
        source_ref: `formation_wizard_submitted:${p.token}`,
      })
      result.steps.push(step("action_card", "ok", "Notification Center card ensured"))
    } catch (e) {
      result.steps.push(step("action_card", "error", e instanceof Error ? e.message : String(e)))
    }
  }

  // Summary
  const okCount = result.steps.filter(s => s.status === "ok").length
  const errCount = result.steps.filter(s => s.status === "error").length
  const skipCount = result.steps.filter(s => s.status === "skipped").length
  result.summary = `${okCount} ok, ${errCount} errors, ${skipCount} skipped`

  return result
}
