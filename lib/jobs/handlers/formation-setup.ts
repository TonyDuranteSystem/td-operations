/**
 * Job Handler: formation_setup
 *
 * Auto-chain for formation wizard submissions:
 * - Data validation (required fields)
 * - Contact update with submitted data
 * - CRM Account creation (LLC placeholder — EIN/formation_date added later)
 * - Service Delivery creation (Company Formation, Stage 1)
 * - Form → reviewed
 * - Email notification to support@ (client completed form)
 * - CRM task for Luca (WhatsApp follow-up)
 * - Portal notification to Contact
 *
 * Triggered by:
 * 1. Portal wizard-submit (source: 'portal_wizard')
 * 2. MCP formation_form_review (source: undefined)
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
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

// State name → code mapping for formation
const STATE_CODE_MAP: Record<string, string> = {
  "New Mexico": "NM", "NM": "NM",
  "Wyoming": "WY", "WY": "WY",
  "Florida": "FL", "FL": "FL",
  "Delaware": "DE", "DE": "DE",
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

  // ─── 2a. CREATE CRM ACCOUNT (LLC placeholder — EIN/formation_date added later) ───
  let accountId: string | null = null
  const companyName = String(submitted.llc_name_1 || "").trim()

  if (companyName && p.contact_id) {
    try {
      // Fetch submission for entity_type and state
      const { data: formSub } = await supabaseAdmin
        .from("formation_submissions")
        .select("entity_type, state")
        .eq("id", p.submission_id)
        .single()

      const entityType = formSub?.entity_type || "SMLLC"
      const stateRaw = formSub?.state || ""
      const stateCode = STATE_CODE_MAP[stateRaw] || stateRaw

      // Check if account already exists for this company name
      const { data: existingAcct } = await supabaseAdmin
        .from("accounts")
        .select("id")
        .ilike("company_name", companyName)
        .limit(1)

      if (existingAcct?.length) {
        accountId = existingAcct[0].id
        result.steps.push(step("account_create", "skipped", `Already exists: ${accountId}`))
      } else {
        // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
        const { data: newAcct, error: acctErr } = await supabaseAdmin
          .from("accounts")
          .insert({
            company_name: companyName,
            entity_type: entityType as never,
            state_of_formation: stateCode,
            account_type: "Formation",
            status: "Pending Formation",
            // EIN, formation_date, registered_agent — filled later when state confirms
          })
          .select("id")
          .single()

        if (acctErr || !newAcct) {
          result.steps.push(step("account_create", "error", acctErr?.message || "insert failed"))
        } else {
          accountId = newAcct.id

          // Link contact to account
          const { error: linkErr } = await supabaseAdmin
            .from("account_contacts")
            .insert({
              account_id: newAcct.id,
              contact_id: p.contact_id,
              role: "Owner",
            })

          if (linkErr && !linkErr.message.includes("duplicate")) {
            result.steps.push(step("account_create", "ok", `${companyName} (${entityType}, ${stateCode}) — link error: ${linkErr.message}`))
          } else {
            result.steps.push(step("account_create", "ok", `${companyName} (${entityType}, ${stateCode}) → linked to contact`))
          }
        }
      }

      // Also link to submission for traceability
      if (accountId) {
        await supabaseAdmin
          .from("formation_submissions")
          // @ts-expect-error account_id may exist as DB column not in generated types
          .update({ account_id: accountId })
          .eq("id", p.submission_id)

        // Backfill account_id on contact-only invoices (created at signing, before account existed)
        if (p.contact_id) {
          const { count: backfilledInv } = await supabaseAdmin
            .from("client_invoices")
            .update({ account_id: accountId, updated_at: new Date().toISOString() })
            .eq("contact_id", p.contact_id)
            .is("account_id", null)

          // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
          const { count: backfilledPay } = await supabaseAdmin
            .from("payments")
            .update({ account_id: accountId, updated_at: new Date().toISOString() })
            .eq("contact_id", p.contact_id)
            .is("account_id", null)

          if ((backfilledInv ?? 0) > 0 || (backfilledPay ?? 0) > 0) {
            result.steps.push(step("invoice_backfill", "ok", `Backfilled account_id on ${backfilledInv ?? 0} invoices, ${backfilledPay ?? 0} payments`))
          }
        }
      }
    } catch (e) {
      result.steps.push(step("account_create", "error", e instanceof Error ? e.message : String(e)))
    }
    await updateJobProgress(job.id, result)
  } else {
    result.steps.push(step("account_create", "skipped", companyName ? "No contact_id" : "No LLC name in submitted data"))
  }

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

  // ─── 2b. CREATE / UPDATE CONTACTS FOR ADDITIONAL MMLLC MEMBERS ───
  const additionalMembers = Array.isArray(submitted.additional_members)
    ? (submitted.additional_members as Array<Record<string, unknown>>)
    : []

  if (additionalMembers.length > 0 && accountId) {
    const primaryMemberIndex = typeof submitted.primary_member_index === 'number'
      ? submitted.primary_member_index : 0

    // Fetch upload_paths from DB (not in job payload)
    const { data: subForPaths } = p.submission_id
      ? await supabaseAdmin.from('formation_submissions').select('upload_paths').eq('id', p.submission_id).single()
      : { data: null }
    const uploadPaths: string[] = (subForPaths?.upload_paths as string[]) ?? []

    // Update owner's is_primary on account_contacts
    if (p.contact_id) {
      await supabaseAdmin.from('account_contacts')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- is_primary added via script 28c, not yet in generated types
        .update({ is_primary: primaryMemberIndex === 0 } as any)
        .eq('account_id', accountId)
        .eq('contact_id', p.contact_id)
    }

    for (let i = 0; i < additionalMembers.length; i++) {
      const m = additionalMembers[i]
      const isPrimary = primaryMemberIndex === i + 1
      const memberEmail = m.member_email ? String(m.member_email).toLowerCase().trim() : null
      const memberName = [m.member_first_name, m.member_last_name].filter(Boolean).map(String).join(' ') || memberEmail || `Member ${i + 1}`

      try {
        // Find or create contact by email
        let membContactId: string | null = null
        if (memberEmail) {
          const { data: existingC } = await supabaseAdmin
            .from('contacts')
            .select('id')
            .eq('email', memberEmail)
            .limit(1)

          if (existingC?.length) {
            membContactId = existingC[0].id
          } else {
            const contactInsert: Record<string, unknown> = {
              email: memberEmail,
              first_name: m.member_first_name ? String(m.member_first_name) : undefined,
              last_name: m.member_last_name ? String(m.member_last_name) : undefined,
              created_at: now,
              updated_at: now,
            }
            // eslint-disable-next-line no-restricted-syntax, @typescript-eslint/no-explicit-any -- deferred migration, dev_task 7ebb1e0c
            const { data: newC } = await supabaseAdmin.from('contacts').insert(contactInsert as any).select('id').single()
            membContactId = newC?.id ?? null
          }
        }

        if (membContactId) {
          // Update contact fields
          const upd: Record<string, unknown> = { updated_at: now }
          if (m.member_first_name) upd.first_name = String(m.member_first_name)
          if (m.member_last_name) upd.last_name = String(m.member_last_name)
          if (m.member_dob) upd.date_of_birth = String(m.member_dob)
          if (m.member_nationality) upd.citizenship = String(m.member_nationality)
          if (m.member_street) upd.address_line1 = String(m.member_street)
          if (m.member_city) upd.address_city = String(m.member_city)
          if (m.member_state_province) upd.address_state = String(m.member_state_province)
          if (m.member_zip) upd.address_zip = String(m.member_zip)
          if (m.member_country) upd.address_country = String(m.member_country)
          // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
          await supabaseAdmin.from('contacts').update(upd).eq('id', membContactId)

          // Link to account with role=Member + is_primary
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- is_primary added via script 28c, not yet in generated types
          const { error: acLinkErr } = await supabaseAdmin
            .from('account_contacts')
            .upsert(
              { account_id: accountId, contact_id: membContactId, role: 'Member', is_primary: isPrimary } as any,
              { onConflict: 'account_id,contact_id' }
            )

          if (acLinkErr && !acLinkErr.message.includes('duplicate')) {
            result.steps.push(step(`member_${i + 1}_link`, 'error', acLinkErr.message))
          } else {
            result.steps.push(step(`member_${i + 1}_link`, 'ok', `${memberName}${isPrimary ? ' [PRIMARY]' : ''}`))
          }

          // Passport: find path in upload_paths by key pattern passport_member_${i}
          const passportPath = uploadPaths.find(p => p.includes(`passport_member_${i}`))
          if (passportPath && contactDriveFolderId) {
            try {
              const cleanPath = passportPath.replace(/^\/+/, '')
              const { data: blob, error: dlErr } = await supabaseAdmin.storage
                .from('onboarding-uploads')
                .download(cleanPath)

              if (dlErr || !blob) {
                result.steps.push(step(`member_${i + 1}_passport`, 'error', dlErr?.message || 'Download failed'))
              } else {
                const { uploadBinaryToDrive } = await import('@/lib/google-drive')
                const fileName = cleanPath.split('/').pop() || `passport_member_${i + 1}.pdf`
                const buffer = Buffer.from(await blob.arrayBuffer())
                const mimeType = blob.type || 'application/octet-stream'

                const driveFile = await uploadBinaryToDrive(fileName, buffer, mimeType, contactDriveFolderId) as { id: string; name: string }

                const { extractAndStorePassportData } = await import('@/lib/jobs/passport-writeback')
                const passRes = await extractAndStorePassportData({
                  contact_id: membContactId,
                  drive_file_id: driveFile.id,
                  mime_type: mimeType,
                  skip_dob: !!m.member_dob,
                  contact_name: memberName,
                  account_id: accountId,
                })
                result.steps.push(step(`member_${i + 1}_passport_ocr`, passRes.status, passRes.detail))

                await supabaseAdmin.from('documents').insert({
                  file_name: fileName,
                  drive_file_id: driveFile.id,
                  drive_link: `https://drive.google.com/file/d/${driveFile.id}/view`,
                  document_type_name: 'Passport',
                  category: 2,
                  category_name: 'Contacts',
                  status: 'classified',
                  contact_id: membContactId,
                  account_id: accountId,
                  portal_visible: true,
                })
              }
            } catch (passErr) {
              result.steps.push(step(`member_${i + 1}_passport`, 'error', passErr instanceof Error ? passErr.message : String(passErr)))
            }
          }
        } else {
          result.steps.push(step(`member_${i + 1}_link`, 'skipped', 'No email — cannot create/find contact'))
        }
      } catch (membErr) {
        result.steps.push(step(`member_${i + 1}`, 'error', membErr instanceof Error ? membErr.message : String(membErr)))
      }
    }

    await updateJobProgress(job.id, result)
  }

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
        const sdName = companyName ? `Company Formation - ${companyName}` : "Company Formation"
        // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
        const { data: sd, error: sdErr } = await supabaseAdmin
          .from("service_deliveries")
          .insert({
            service_name: sdName,
            service_type: "Company Formation",
            pipeline: "Company Formation",
            stage: "Data Collection",
            stage_order: 1,
            stage_entered_at: now,
            stage_history: JSON.stringify([{ stage: "Data Collection", entered_at: now, by: "formation_setup" }]),
            contact_id: sdContactId,
            account_id: accountId, // Now linked to CRM account
            status: "active",
            start_date: now.slice(0, 10),
            assigned_to: "Luca",
          })
          .select("id")
          .single()

        if (sdErr) {
          result.steps.push(step("service_delivery", "error", sdErr.message))
        } else {
          result.steps.push(step("service_delivery", "ok", `SD created: ${sd.id} (Data Collection${accountId ? ", linked to account" : ""})`))
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

  // Summary
  const okCount = result.steps.filter(s => s.status === "ok").length
  const errCount = result.steps.filter(s => s.status === "error").length
  const skipCount = result.steps.filter(s => s.status === "skipped").length
  result.summary = `${okCount} ok, ${errCount} errors, ${skipCount} skipped`

  return result
}
