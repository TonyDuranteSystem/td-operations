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
import { createSD, OPEN_TASK_STATUSES } from "@/lib/operations/service-delivery"
import { advanceServiceDelivery } from "@/lib/service-delivery"
import { updateJobProgress, type Job, type JobResult } from "../queue"
import { validateFormationData } from "../validation"
import { firstUploadPath } from "@/lib/portal/wizard-uploads"

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

      // Mark passport as on file if uploaded (value may be a single path or an
      // array of paths — firstUploadPath handles both; empty array = none).
      if (firstUploadPath(submitted.passport_owner)) {
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
  /** The formation SD for this run — hoisted so the Luca follow-up task (§5)
   *  can stamp `delivery_id`. Without it that task is unreachable from
   *  deactivateSD, which only cancels tasks linked to the service. */
  let formationSdId: string | null = null
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

      // Copy passport from Supabase Storage to Drive. File fields may now hold
      // multiple paths; the owner-passport OCR/Drive flow acts on the first one
      // (any extras remain in storage + upload_paths). dev_task 64bfcdd9.
      const passportPath = firstUploadPath(submitted.passport_owner)
      if (passportPath && contactDriveFolderId) {
        try {
          const contactsSubfolder = folderResult.subfolders["2. Contacts"]
          if (contactsSubfolder) {
            const cleanPath = passportPath.replace(/^\/+/, "")
            // Duplicate-upload guard (LT Program incident): a re-run of this
            // job must not add a second Drive copy. The prior run also did
            // the OCR writeback + documents insert, so skip the whole block.
            const dupCheckName = cleanPath.split("/").pop() || "passport.pdf"
            const { fileExistsInFolder } = await import("@/lib/google-drive")
            const dup = await fileExistsInFolder(contactsSubfolder, dupCheckName)
            if (dup.exists) {
              result.steps.push(step("passport_copy", "skipped", `Already on Drive (${dup.id})`))
            } else {
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

  // ─── 2c. CREATE SERVICE DELIVERY (Company Formation pipeline, Stage 1: Payment Confirmed) ───
  try {
    const sdContactId = p.contact_id
    if (sdContactId) {
      // Check if SD already exists for this contact
      const { data: existingSd, error: existingSdErr } = await supabaseAdmin
        .from("service_deliveries")
        .select("id, stage")
        .eq("contact_id", sdContactId)
        .eq("service_type", "Company Formation")
        .eq("status", "active")
        .limit(1)

      // Fail CLOSED (2026-07-20). supabase-js returns errors instead of
      // throwing, so discarding `error` turned any transient PostgREST failure
      // into "no formation exists" → a DUPLICATE Company Formation on a job
      // retry. Same class of bug as the ITIN duplicate; a guard we cannot trust
      // must stop, not wave the creation through. The job retries.
      if (existingSdErr) {
        throw new Error(
          `formation SD duplicate-check failed (${existingSdErr.message}) — not creating, to avoid a duplicate formation`,
        )
      }

      // Resolve the SD id + current stage from either branch so the
      // wizard-submit stage advance below runs uniformly.
      let sdId: string | null = null
      let sdStage: string | null = null

      if (existingSd && existingSd.length > 0) {
        sdId = existingSd[0].id
        sdStage = existingSd[0].stage
        result.steps.push(step("service_delivery", "skipped", `Already exists at ${sdStage}: ${sdId}`))
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
            // v2 Company Formation pipeline stage_order=1 (migration 20260617);
            // the old "Data Collection" stage no longer exists for this service.
            target_stage: "Payment Confirmed",
            target_stage_order: 1,
            start_date: now.slice(0, 10),
          })
          sdId = sd.id
          sdStage = "Payment Confirmed"
          result.steps.push(step("service_delivery", "ok", `SD created: ${sd.id} (Payment Confirmed, contact-scoped)`))
        } catch (e) {
          result.steps.push(step("service_delivery", "error", e instanceof Error ? e.message : String(e)))
        }
      }

      // Expose the resolved SD to later sections (the Luca follow-up task).
      formationSdId = sdId

      // ─── 2c-bis. ADVANCE Payment Confirmed → Wizard Submitted ───
      // This handler runs because the formation wizard was submitted, but the
      // SD is normally pre-created at "Payment Confirmed" by activate-service —
      // so the "already exists" branch above just skipped, leaving the SD stuck
      // at "Payment Confirmed" forever (Davide Priori, 2026-06-24). Advance it
      // now, but ONLY from "Payment Confirmed" and ONLY when the formation
      // wizard_progress is actually 'submitted'. The stage guard makes this
      // idempotent: a re-run finds the SD at "Wizard Submitted" (≠ "Payment
      // Confirmed") and does nothing, and an SD already past this stage is
      // never regressed.
      if (sdId && sdStage === "Payment Confirmed") {
        const { data: submittedWp } = await supabaseAdmin
          .from("wizard_progress")
          .select("id")
          .eq("contact_id", sdContactId)
          .eq("wizard_type", "formation")
          .eq("status", "submitted")
          .limit(1)
          .maybeSingle()

        if (submittedWp) {
          try {
            const adv = await advanceServiceDelivery({
              delivery_id: sdId,
              target_stage: "Wizard Submitted",
              notes: "Formation wizard submitted",
            })
            result.steps.push(
              step(
                "service_delivery_advance",
                adv.success ? "ok" : "error",
                adv.success
                  ? `SD ${sdId} advanced: Payment Confirmed → Wizard Submitted`
                  : `Advance failed: ${adv.error}`,
              ),
            )
          } catch (e) {
            result.steps.push(step("service_delivery_advance", "error", e instanceof Error ? e.message : String(e)))
          }
        } else {
          result.steps.push(step("service_delivery_advance", "skipped", "Formation wizard_progress not 'submitted' yet"))
        }
      }
    } else {
      result.steps.push(step("service_delivery", "skipped", "No contact_id available"))
    }
  } catch (e) {
    result.steps.push(step("service_delivery", "error", e instanceof Error ? e.message : String(e)))
  }

  // ─── 2b. ITIN SERVICE DELIVERIES (start-at-wizard — dev_task fcf5e254) ───
  // ITIN is personal: it starts now, not when the company is formed. Creates a
  // contact-scoped ITIN SD for each person the client marked "applies for ITIN"
  // in the wizard (owner + members). No-op when the offer had no ITIN. This
  // closes the gap where bundled ITIN was silently dropped at activation.
  if (p.contact_id) {
    try {
      const { createItinDeliveriesFromWizard } = await import("@/lib/operations/itin-from-wizard")
      const itin = await createItinDeliveriesFromWizard({
        contactId: p.contact_id,
        leadId: p.lead_id,
        submitted,
        offerToken: p.token,
      })
      if (itin.created === 0 && itin.skipped === 0) {
        result.steps.push(step("itin_deliveries", "skipped", "No one applied for ITIN"))
      } else {
        result.steps.push(
          step(
            "itin_deliveries",
            "ok",
            `${itin.created} created, ${itin.skipped} existing — ${itin.people.map((x) => `${x.name}:${x.status}`).join(", ")}`,
          ),
        )
      }
    } catch (e) {
      result.steps.push(step("itin_deliveries", "error", e instanceof Error ? e.message : String(e)))
    }
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
        // Portal wizard-submit (buildSubmissionRecord) writes status:"completed"
        // but never stamps completed_at, so the column stays NULL. Stamp it here
        // alongside the review flip. Same `now` as reviewed_at — the auto-chain
        // runs seconds after submission, so this ≈ submission time.
        completed_at: now,
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

    const taskTitle = `WhatsApp follow-up: ${clientName} (formation form completed)`

    // Idempotency (2026-07-20). A client re-submitting the formation wizard
    // re-runs this whole handler, and this insert had no guard — Marcell
    // Bogyora produced a second identical WhatsApp task for Luca 10 days after
    // the first. Skip when an OPEN one already exists for this person.
    let alreadyOpen = false
    if (p.contact_id) {
      // Key on the PERSON + category, never on the title. The title embeds the
      // client's own typed name, so a re-submit that corrects a spelling, fills
      // in a missing surname, or fixes an accent produces a different title and
      // the guard misses — minting exactly the duplicate it exists to stop.
      const { data: existingTask, error: existingTaskErr } = await supabaseAdmin
        .from("tasks")
        .select("id")
        .eq("contact_id", p.contact_id)
        .eq("category", "Formation")
        .ilike("task_title", "WhatsApp follow-up:%")
        // Must cover EVERY open state. "Waiting" is the normal state for a
        // follow-up task Luca has actioned but is awaiting the client on —
        // omitting it would let a wizard re-submit mint a duplicate, which is
        // the exact bug this guard exists to stop.
        .in("status", [...OPEN_TASK_STATUSES])
        .limit(1)
      // Fail CLOSED, consistent with the SD guards: an unverifiable check must
      // not mint a duplicate. A missed follow-up task is recoverable; a
      // duplicate one wastes Luca's time and confuses the client-contact trail.
      if (existingTaskErr) {
        result.steps.push(
          step("luca_whatsapp_task", "skipped", `duplicate check failed (${existingTaskErr.message}) — not created`),
        )
        alreadyOpen = true
      } else if (existingTask && existingTask.length > 0) {
        result.steps.push(step("luca_whatsapp_task", "skipped", `Already open: ${existingTask[0].id}`))
        alreadyOpen = true
      }
    }

    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
    const { error: taskErr } = alreadyOpen ? { error: null } : await supabaseAdmin.from("tasks").insert({
      task_title: taskTitle,
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
      // Link the task to the person AND the service. It carried neither, so it
      // was invisible to deactivateSD (which cancels by delivery_id) and had to
      // be cancelled by hand when the duplicate formation run was cleaned up.
      ...(p.contact_id ? { contact_id: p.contact_id } : {}),
      ...(formationSdId ? { delivery_id: formationSdId } : {}),
    })

    if (taskErr) {
      result.steps.push(step("luca_whatsapp_task", "error", taskErr.message))
    } else if (!alreadyOpen) {
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

  // Summary
  const okCount = result.steps.filter(s => s.status === "ok").length
  const errCount = result.steps.filter(s => s.status === "error").length
  const skipCount = result.steps.filter(s => s.status === "skipped").length
  result.summary = `${okCount} ok, ${errCount} errors, ${skipCount} skipped`

  return result
}
