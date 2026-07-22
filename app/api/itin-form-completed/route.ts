/**
 * POST /api/itin-form-completed
 *
 * Called by the ITIN form frontend after the client submits.
 * Auto-chain per ITIN SOP v4.0:
 *
 * 1. Update CRM contact (DOB, nationality, address, visa — changed fields only)
 * 2. Create Leads/{name}/ folder if standalone client (no account)
 * 3. Save data summary PDF to Drive
 * 4. Advance SD: Data Collection -> Document Preparation
 * 5. Auto-generate W-7 + 1040-NR + Schedule OI via itin_prepare_documents
 * 6. Email team (internal, support@) with all data + "Documents generated, please review"
 * 7. Create a plain task pointing to the workspace (/flows/[sd_id]) — NOT a
 *    workflow task. Managing the ITIN happens entirely in the workspace.
 * 8. Update SD history
 * 9. Log action
 *
 * Body: { submission_id: string, token: string }
 * No auth required (public endpoint - only triggers internal notifications)
 */

// Added 2026-04-14 P0.7: protect the 8-step auto-chain from mid-execution
// Vercel timeout (Drive folder + PDF gen + docs + email + task + history + log).
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { dbWrite, dbWriteSafe } from "@/lib/db"
import { createSD, advanceStageIfAt } from "@/lib/operations/service-delivery"
import { autoSaveDocument } from "@/lib/portal/auto-save-document"
import { APP_BASE_URL } from "@/lib/config"
import { generateW7Pdf, generate1040NRPdf, generateScheduleOIPdf } from "@/lib/itin-pdf-generator"
import { dispatchWorkflowForFormCompletion } from "@/lib/tasks/dispatch-workflow-for-event"
import { defaultTaskAssignee } from "@/lib/tasks/default-assignee"
import type { Json } from "@/lib/database.types"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { submission_id, token } = body as { submission_id?: string; token?: string }

    if (!submission_id || !token) {
      return NextResponse.json({ error: "submission_id and token required" }, { status: 400 })
    }

    const { data: sub, error: subErr } = await supabaseAdmin
      .from("itin_submissions")
      .select("id, token, lead_id, account_id, contact_id, language, status")
      .eq("id", submission_id)
      .eq("token", token)
      .single()

    if (subErr || !sub) {
      return NextResponse.json({ error: "Submission not found" }, { status: 404 })
    }

    if (sub.status !== "completed") {
      return NextResponse.json({ error: "Form not completed" }, { status: 400 })
    }

    const results: { step: string; status: string; detail?: string }[] = []

    // Get client name
    let clientName = token
    if (sub.lead_id) {
      const { data: lead } = await supabaseAdmin.from("leads").select("full_name").eq("id", sub.lead_id).single()
      if (lead) { clientName = lead.full_name }
    } else if (sub.contact_id) {
      const { data: contact } = await supabaseAdmin.from("contacts").select("full_name").eq("id", sub.contact_id).single()
      if (contact) { clientName = contact.full_name }
    }

    // Get company name if linked.
    //
    // An ITIN submission is keyed on the PERSON and carries no account_id (see
    // accountIdForWizardSubmission — two members of one LLC must not share one
    // submission). The client's company is therefore resolved from the CONTACT's
    // linked account, not from the submission. Without this fallback an ITIN
    // bought by someone who owns a company loses the company label here and
    // files into a Leads folder below instead of the company folder.
    let companyName: string | null = null
    let driveAccountId: string | null = sub.account_id ?? null
    if (!driveAccountId && sub.contact_id) {
      const { data: link } = await supabaseAdmin
        .from("account_contacts")
        .select("account_id")
        .eq("contact_id", sub.contact_id)
        .order("is_primary", { ascending: false })
        .order("account_id", { ascending: true })
        .limit(1)
        .maybeSingle()
      driveAccountId = link?.account_id ?? null
    }
    if (driveAccountId) {
      const { data: acc } = await supabaseAdmin.from("accounts").select("company_name").eq("id", driveAccountId).single()
      if (acc) companyName = acc.company_name
    }
    const displayName = companyName ? `${clientName} (${companyName})` : clientName

    // Get full submission data
    const { data: fullSub } = await supabaseAdmin
      .from("itin_submissions")
      .select("submitted_data, upload_paths, completed_at")
      .eq("id", submission_id)
      .single()
    const sd = (fullSub?.submitted_data || {}) as Record<string, unknown>
    const uploadPaths = (fullSub?.upload_paths || []) as string[]

    // --- STEP 1: Update CRM contact (changed fields only) ---
    let contactId = sub.contact_id
    if (!contactId && sub.lead_id) {
      // Find or create contact from lead
      const { data: lead } = await supabaseAdmin.from("leads").select("full_name, email, phone, language").eq("id", sub.lead_id).single()
      if (lead) {
        const { data: existing } = await supabaseAdmin.from("contacts").select("id").ilike("email", lead.email || "noemail").limit(1)
        if (existing?.length) {
          contactId = existing[0].id
        } else {
          const newC = await dbWrite(
            // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw contacts.insert; extract to lib/operations/ per dev_task fda76fd3
            supabaseAdmin.from("contacts").insert({
              full_name: lead.full_name, email: lead.email, phone: lead.phone,
              language: lead.language === "Italian" ? "it" : "en",
            }).select("id").single(),
            "contacts.insert"
          )
          if (newC) { contactId = newC.id; results.push({ step: "contact_created", status: "ok", detail: contactId }) }
        }
      }
    }

    if (contactId) {
      try {
        const { data: contact } = await supabaseAdmin.from("contacts").select("date_of_birth, citizenship, residency, phone").eq("id", contactId).single()
        const updates: Record<string, unknown> = {}

        if (sd.dob && sd.dob !== contact?.date_of_birth) updates.date_of_birth = sd.dob
        if (sd.citizenship && sd.citizenship !== contact?.citizenship) updates.citizenship = sd.citizenship
        if (sd.phone && sd.phone !== contact?.phone) updates.phone = sd.phone

        const addr = [sd.foreign_street, sd.foreign_city, sd.foreign_state, sd.foreign_zip, sd.foreign_country].filter(Boolean).join(", ")
        if (addr && addr !== contact?.residency) updates.residency = addr

        // Save extra ITIN-specific data in notes
        const extraInfo = [
          sd.country_of_birth ? `Country of birth: ${sd.country_of_birth}` : "",
          sd.city_of_birth ? `City of birth: ${sd.city_of_birth}` : "",
          sd.gender ? `Gender: ${sd.gender}` : "",
          sd.us_visa_type ? `Visa: ${sd.us_visa_type}` : "",
          sd.passport_number ? `Passport: ${sd.passport_number}` : "",
          sd.foreign_tax_id ? `Foreign Tax ID: ${sd.foreign_tax_id}` : "",
        ].filter(Boolean).join("; ")
        if (extraInfo) updates.notes = extraInfo

        if (Object.keys(updates).length > 0) {
          updates.updated_at = new Date().toISOString()
          await dbWrite(
            // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw contacts.update; extract to lib/operations/ per dev_task fda76fd3
            supabaseAdmin.from("contacts").update(updates).eq("id", contactId),
            "contacts.update"
          )
          results.push({ step: "crm_update", status: "ok", detail: `Updated: ${Object.keys(updates).filter(k => k !== "updated_at").join(", ")}` })
        } else {
          results.push({ step: "crm_update", status: "skipped", detail: "No changes" })
        }
      } catch (e) {
        results.push({ step: "crm_update", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // --- STEP 2: Create Drive folder + save data PDF ---
    let driveFolderId = ""
    try {
      const { listFolder, createFolder } = await import("@/lib/google-drive")
      const { saveFormToDrive } = await import("@/lib/form-to-drive")

      // Use the client's company Drive folder when they have one. `driveAccountId`
      // is the submission's account when present, else the contact's linked
      // account — an ITIN submission is person-keyed and carries no account_id,
      // so reading sub.account_id alone would send every ITIN package of a
      // company-owning client into a Leads folder.
      if (driveAccountId) {
        const { data: acc } = await supabaseAdmin.from("accounts").select("drive_folder_id").eq("id", driveAccountId).single()
        if (acc?.drive_folder_id) driveFolderId = acc.drive_folder_id
      }

      if (!driveFolderId) {
        // Standalone: create Leads/{name}/ folder
        const TD_CLIENTS_FOLDER = "1mbz_bUDwC4K259RcC-tDKihjlvdAVXno"
        const clientsContents = await listFolder(TD_CLIENTS_FOLDER) as { files?: { id: string; name: string; mimeType: string }[] }
        let leadsParent = clientsContents?.files?.find(
          (f: { name: string; mimeType: string }) => f.name === "Leads" && f.mimeType === "application/vnd.google-apps.folder"
        )
        if (!leadsParent) {
          const nf = await createFolder(TD_CLIENTS_FOLDER, "Leads")
          leadsParent = { id: nf.id, name: "Leads", mimeType: "application/vnd.google-apps.folder" }
        }

        const folderName = clientName || token
        const leadsContents = await listFolder(leadsParent.id) as { files?: { id: string; name: string; mimeType: string }[] }
        let clientFolder = leadsContents?.files?.find(
          (f: { name: string; mimeType: string }) => f.name === folderName && f.mimeType === "application/vnd.google-apps.folder"
        )
        if (!clientFolder) {
          const nf = await createFolder(leadsParent.id, folderName)
          clientFolder = { id: nf.id, name: folderName, mimeType: "application/vnd.google-apps.folder" }
        }
        driveFolderId = clientFolder.id
      }

      if (driveFolderId) {
        const driveResult = await saveFormToDrive(
          "itin", sd, uploadPaths, driveFolderId,
          { token, submittedAt: fullSub?.completed_at || new Date().toISOString(), companyName: displayName }
        )
        results.push({ step: "drive_save", status: "ok", detail: `Summary: ${driveResult.summaryFileId ? "saved" : "failed"}. Files: ${driveResult.copied.length} copied.` })
      }
    } catch (e) {
      results.push({ step: "drive_save", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // --- STEP 3: Ensure SD exists + advance to Document Preparation ---
    let deliveryId: string | null = null
    try {
      const orFilters = [`notes.ilike.%${token}%`]
      if (sub.account_id) orFilters.push(`account_id.eq.${sub.account_id}`)
      if (contactId) orFilters.push(`contact_id.eq.${contactId}`)

      // Fixed 2026-04-14 P0.4: four sites were writing to a ghost column on
      // service_deliveries — the real column is "stage". Silently produced
      // "stuck at Data Collection" for Manuel Burdo and the external ITIN
      // form class. Also destructures .error on the supabase calls so future
      // failures do not fall into the same silent-write hole. See plan
      // docs/2026-04-14-restructure-plan-final-v1.md §4 P0.4.
      const { data: existingSd, error: existingSdError } = await supabaseAdmin
        .from("service_deliveries")
        .select("id, stage")
        .eq("service_type", "ITIN")
        .or(orFilters.join(","))
        .eq("status", "active")
        // DETERMINISTIC pick (2026-07-20). Without an explicit order this
        // `.limit(1)` returned an arbitrary row, so a contact who somehow holds
        // two active ITIN SDs could have their W-7 / 1040-NR / Schedule OI and
        // the staff review task filed against the WRONG one — while the real
        // application sat untouched at a later stage. Oldest-first pins it to
        // the original application. The duplicate itself is prevented upstream
        // (lib/operations/itin-from-wizard.ts + uq_itin_sd_active_per_contact);
        // this ordering is the defence-in-depth for any that slip through.
        .order("created_at", { ascending: true })
        .limit(1)

      if (existingSdError) {
        console.error("[itin-form-completed] service_deliveries SELECT failed:", existingSdError)
        results.push({ step: "sd_select", status: "error", detail: existingSdError.message })
      }

      if (existingSd?.length) {
        deliveryId = existingSd[0].id
        // Advance Data Collection → Document Preparation via P1.6 operation
        // layer — gate on current stage to avoid double-advance; skip auto-
        // tasks because this route creates its own "Review ITIN documents"
        // task in STEP 6.
        const advanceResult = await advanceStageIfAt({
          delivery_id: deliveryId,
          if_current_stage: "Data Collection",
          target_stage: "Document Preparation",
          actor: "itin-form-completed",
          notes: `ITIN form ${token} submitted`,
          skip_tasks: true,
        })
        if (advanceResult.advanced) {
          results.push({ step: "sd_advance", status: "ok", detail: `SD ${deliveryId} -> Document Preparation` })
        } else if (advanceResult.current_stage === "Data Collection") {
          // Gate matched but advance failed inside advanceServiceDelivery
          results.push({ step: "sd_advance", status: "error", detail: advanceResult.result?.error || advanceResult.reason })
        } else {
          // Gate not matched — SD already moved forward; safe to ignore
          results.push({ step: "sd_advance", status: "skipped", detail: advanceResult.reason })
        }
      } else {
        // Auto-create SD at Document Preparation (stage 2) since the client
        // has already submitted their ITIN data — we skip the "Data
        // Collection" intake stage.
        try {
          // Phase 1 ITIN rule (2026-05-11): ITIN SDs always live on contact_id
          // with account_id=null, even when sub.account_id is set. createSD
          // enforces this defensively, but we pass null explicitly so the
          // caller is honest about the architecture.
          const newSd = await createSD({
            service_type: "ITIN",
            service_name: `ITIN - ${clientName}`,
            account_id: null,
            contact_id: contactId,
            target_stage: "Document Preparation",
            notes: `Auto-created from ITIN form ${token}`,
          })
          deliveryId = newSd.id
          results.push({ step: "sd_created", status: "ok", detail: `SD auto-created at Document Preparation: ${deliveryId}` })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          console.error("[itin-form-completed] createSD failed:", msg)
          results.push({ step: "sd_created", status: "error", detail: msg })
        }
      }
    } catch (e) {
      results.push({ step: "sd_check", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // --- STEP 4: Auto-generate W-7 + 1040-NR + Schedule OI ---
    // Bug #5 fix (2026-05-14, dev_task 222be20a): the previous version of this
    // step used a `webpackIgnore: true` dynamic import via a string variable
    // (`const modPath = "@/lib/itin-pdf-generator"; await import(modPath)`).
    // That pattern fails silently at Vercel's serverless runtime because the
    // `@/`-aliased path is not resolved when webpack is told to skip it. The
    // import threw, the surrounding `try { ... } catch {}` swallowed the error,
    // `generateW7Pdf` stayed null, and the gate below reported the misleading
    // "Missing name fields". Net effect: every portal-wizard ITIN client (and
    // every external-form client) silently skipped this step and required a
    // manual `itin_prepare_documents` MCP call by Luca to generate the PDFs.
    // Now: static import at top of file (handler import is build-validated);
    // gate split so each failure mode reports honestly.
    let docsGenerated = false
    try {
      if (!sd.first_name || !sd.last_name) {
        results.push({ step: "docs_generated", status: "skipped", detail: "Missing first_name or last_name in submission data" })
      } else {
        const w7Buffer = await generateW7Pdf(sd)
        const nrBuffer = await generate1040NRPdf(sd)
        const oiBuffer = await generateScheduleOIPdf(sd)

        // Upload all 3 to Drive
        if (driveFolderId) {
          const { uploadBinaryToDriveUpsert, folderFileNameMap, listFolder: lf, createFolder: cf } = await import("@/lib/google-drive")

          // Find or create ITIN subfolder
          const contents = await lf(driveFolderId) as { files?: { id: string; name: string; mimeType: string }[] }
          let itinFolder = contents?.files?.find(
            (f: { name: string; mimeType: string }) => f.name === "ITIN" && f.mimeType === "application/vnd.google-apps.folder"
          )
          if (!itinFolder) {
            const nf = await cf(driveFolderId, "ITIN")
            itinFolder = { id: nf.id, name: "ITIN", mimeType: "application/vnd.google-apps.folder" }
          }

          const slug = `${sd.first_name}_${sd.last_name}`.replace(/\s+/g, "_")
          const w7Name = `W-7_${slug}.pdf`
          const nrName = `1040-NR_${slug}.pdf`
          const oiName = `Schedule_OI_${slug}.pdf`
          // Stable file names → UPSERT: a re-run/regenerate refreshes the one
          // existing PDF in place instead of piling up copies (LT Program
          // Drive-duplicate incident class). One folder listing feeds all 3.
          const itinNames = await folderFileNameMap(itinFolder.id)
          const w7Upload = await uploadBinaryToDriveUpsert(w7Name, w7Buffer, "application/pdf", itinFolder.id, itinNames) as { id?: string }
          const nrUpload = await uploadBinaryToDriveUpsert(nrName, nrBuffer, "application/pdf", itinFolder.id, itinNames) as { id?: string }
          const oiUpload = await uploadBinaryToDriveUpsert(oiName, oiBuffer, "application/pdf", itinFolder.id, itinNames) as { id?: string }

          docsGenerated = true

          results.push({ step: "docs_generated", status: "ok", detail: `W-7 + 1040-NR + Schedule OI generated and uploaded to Drive/ITIN/` })

          // Register PDFs in the portal documents table so the client sees
          // them under Documents (category=3 Tax, portal_visible=true) and so
          // they surface on the flow workspace / portal flow page (queried by
          // service_delivery_id). ITIN SDs are contact-only by Phase 1 rule;
          // autoSaveDocument accepts contact_id for pure contact-only ITINs. If
          // the contact also owns an LLC (sub.account_id set), file under that
          // account so other account members can see the docs.
          //
          // 2026-06-25 (Issue 2 fix — Daniel Pasztor): the previous version
          // ignored autoSaveDocument's return value and ALWAYS pushed a
          // docs_generated "ok", masking insert failures (the documents row
          // never appeared yet the action_log said "ok"). autoSaveDocument never
          // throws — it returns { error } — so the bug was invisible. We now (a)
          // skip + report any PDF whose Drive upload returned no id (a null
          // drive_file_id violates the documents NOT NULL constraint — verified),
          // and (b) check each return value and surface the actual error in a
          // dedicated docs_registered result.
          const registrationTarget: { accountId?: string; contactId?: string } | null =
            sub.account_id ? { accountId: sub.account_id } : contactId ? { contactId } : null

          if (!registrationTarget) {
            results.push({ step: "docs_registered", status: "skipped", detail: "No account or contact — portal documents not registered" })
          } else {
            const toRegister: { fileName: string; documentType: string; driveId?: string }[] = [
              { fileName: w7Name, documentType: "ITIN W-7", driveId: w7Upload?.id },
              { fileName: nrName, documentType: "ITIN 1040-NR", driveId: nrUpload?.id },
              { fileName: oiName, documentType: "ITIN Schedule OI", driveId: oiUpload?.id },
            ]
            const regErrors: string[] = []
            let regOk = 0
            for (const doc of toRegister) {
              if (!doc.driveId) {
                regErrors.push(`${doc.documentType}: Drive upload returned no file id`)
                continue
              }
              const saved = await autoSaveDocument({
                ...registrationTarget,
                fileName: doc.fileName,
                documentType: doc.documentType,
                category: 3,
                driveFileId: doc.driveId,
                portalVisible: true,
                serviceDeliveryId: deliveryId,
              })
              if (saved.error) {
                regErrors.push(`${doc.documentType}: ${saved.error}`)
              } else {
                regOk++
              }
            }
            const scope = sub.account_id ? "account-scoped" : "contact-scoped"
            if (regErrors.length === 0) {
              results.push({ step: "docs_registered", status: "ok", detail: `${regOk}/3 registered in portal documents (${scope})` })
            } else {
              console.error(`[itin-form-completed] document registration failed: ${regErrors.join(" | ")}`)
              results.push({ step: "docs_registered", status: "error", detail: `${regOk}/3 registered (${scope}). Failures: ${regErrors.join("; ")}` })
            }
          }
        }
      }
    } catch (e) {
      results.push({ step: "docs_generated", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // --- STEP 5: Email team ---
    try {
      const { gmailPost } = await import("@/lib/gmail")

      const emailBody = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a">
<h2>[TASK] ITIN Form Completed - ${displayName}</h2>
<p>Client <strong>${displayName}</strong> has submitted the ITIN data collection form.</p>

<h3>Personal Information</h3>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:4px 8px;font-weight:bold">Name:</td><td style="padding:4px 8px">${sd.first_name || ""} ${sd.last_name || ""}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">DOB:</td><td style="padding:4px 8px">${sd.dob || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Gender:</td><td style="padding:4px 8px">${sd.gender || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Citizenship:</td><td style="padding:4px 8px">${sd.citizenship || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Country of birth:</td><td style="padding:4px 8px">${sd.country_of_birth || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">City of birth:</td><td style="padding:4px 8px">${sd.city_of_birth || "N/A"}</td></tr>
</table>

<h3>Foreign Address</h3>
<p>${[sd.foreign_street, sd.foreign_city, sd.foreign_state, sd.foreign_zip, sd.foreign_country].filter(Boolean).join(", ") || "N/A"}</p>

<h3>Visa / US Info</h3>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:4px 8px;font-weight:bold">Visa type:</td><td style="padding:4px 8px">${sd.us_visa_type || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Passport #:</td><td style="padding:4px 8px">${sd.passport_number || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Foreign Tax ID:</td><td style="padding:4px 8px">${sd.foreign_tax_id || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Previous ITIN:</td><td style="padding:4px 8px">${sd.has_previous_itin ? sd.previous_itin || "Yes" : "No"}</td></tr>
</table>

<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/>

<h3>Documents Status</h3>
<p>${docsGenerated ? '<strong style="color:#16a34a">W-7 + 1040-NR + Schedule OI GENERATED and uploaded to Drive.</strong><br/>Please review the documents before sending to client.' : '<strong style="color:#dc2626">Document generation failed -- run itin_prepare_documents manually.</strong>'}</p>

<h3>Next Steps</h3>
<ol>
<li>Review the generated W-7, 1040-NR, and Schedule OI in Drive</li>
<li>If correct, send to client for signature: <code>itin_prepare_documents(token="${token}", send_email=true)</code></li>
<li>Client prints, signs, prints passport copies, mails to Seminole FL</li>
</ol>

<p style="font-size:12px;color:#6b7280">Token: ${token} | Admin: ${APP_BASE_URL}/itin-form/${token}?preview=td</p>
</div>`

      const itinSubject = `[TASK] ITIN Form Completed - ${displayName}`
      const encodedSubject = `=?utf-8?B?${Buffer.from(itinSubject).toString("base64")}?=`
      const raw = Buffer.from(
        `From: Tony Durante CRM <support@tonydurante.us>\r\n` +
        `To: support@tonydurante.us\r\n` +
        `Subject: ${encodedSubject}\r\n` +
        `MIME-Version: 1.0\r\n` +
        `Content-Type: text/html; charset=utf-8\r\n\r\n` +
        emailBody
      ).toString("base64url")

      await gmailPost("/messages/send", { raw })
      results.push({ step: "email_team", status: "ok", detail: "Detailed email sent to support@" })
    } catch (e) {
      results.push({ step: "email_team", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // --- STEP 6: Notify staff via the itin_review WORKSPACE-POINTER workflow ---
    // 2026-06-26: the ITIN flow is managed EXCLUSIVELY from the workspace
    // (/flows/[sd_id]), but the staff notification MUST surface in the What's New
    // feed (Portal Chats) where Luca watches — NOT only on the task board. That
    // feed is driven by the `workflow_spawned` chat-event the dispatcher emits;
    // a plain tasks.insert emits nothing, so it was invisible there (regression).
    //
    // Fix (mirrors formation_progress): itin_review is now a `workspace_pointer`
    // catalog workflow with EMPTY actions + the lightweight sd_progress_v1 meta.
    // Dispatching it (a) emits workflow_spawned → the What's New note, and (b)
    // creates a task whose WorkflowTaskCard renders "Open in Workspace"
    // (/flows/[delivery_id]) and NO action buttons (workspace_pointer empties
    // them). No email-the-client handler exists; the client message comes only
    // from the Document Preparation → Client Signing advance hook in
    // lib/service-delivery.ts §8c. Idempotent by submission_id (dispatcher) and
    // task_title (outer guard). Falls back to a plain task if the SD is missing
    // or the dispatch can't match (defensive — keeps the chain robust).
    try {
      const taskTitle = docsGenerated
        ? `Review ITIN documents -- ${displayName}`
        : `Review ITIN form data -- ${displayName}`

      const { data: existingTask } = await supabaseAdmin
        .from("tasks").select("id").eq("task_title", taskTitle).maybeSingle()

      if (!existingTask) {
        const workspaceUrl = deliveryId ? `/flows/${deliveryId}` : null
        const description = docsGenerated
          ? `W-7 + 1040-NR + Schedule OI have been auto-generated for ${displayName}.\n\n${workspaceUrl ? `Open the workspace to review and advance: ${workspaceUrl}` : "Open the ITIN workspace to review and advance."}\n\nReview the PDFs, then click the advance button ("Documents Reviewed — Send to Client"). That posts the client a portal message with the print / wet-ink-sign / passport-copies / mail-to-office instructions. Do NOT email the client — the portal is the delivery mechanism.`
          : `ITIN form completed for ${displayName}.\n\nDocument generation did not run.\n${workspaceUrl ? `Open the workspace to review: ${workspaceUrl}\n` : ""}You can regenerate the documents with itin_prepare_documents(token="${token}") if needed.`

        let workflowSpawned = false
        // Only the workspace-pointer workflow gives the What's New note + the
        // workspace link, and it needs a delivery_id for that link.
        if (deliveryId) {
          const dispatch = await dispatchWorkflowForFormCompletion({
            form_table: "itin_submissions",
            submission: { ...sub },
            build_task_meta: async () => ({
              service_delivery_id: deliveryId,
              service_type: "ITIN",
              sd_stage: "Document Preparation",
              account_id: sub.account_id ?? null,
              contact_id: contactId ?? null,
            }),
            task_title: taskTitle,
            description,
            // assigned_to omitted — dispatcher resolves catalog default_assignee,
            // then defaultTaskAssignee().
            priority: "High",
            account_id: sub.account_id || null,
            contact_id: contactId || null,
            delivery_id: deliveryId,
            actor: "itin-form-completed:auto-chain",
            // Dedup on the SD (one OPEN itin_review pointer per ITIN SD). Must
            // be a field PRESENT in the pinned task_meta (sd_progress_v1) — the
            // dispatcher checks task_meta->>service_delivery_id on retry.
            //
            // workflow_slug is REQUIRED here: service_delivery_id is carried by
            // other ITIN workflows too. Without it the `itin_data_collection`
            // task ("Send wizard link to client", spawned at SD creation)
            // matched, the dispatcher reported already_spawned, and the review
            // card was never created — for every ITIN client from 2026-07-11
            // (Marcell Bogyora ×3, Tamás Fazekas ×1). The plain-task fallback
            // did not fire either, because already_spawned sets workflowSpawned,
            // so their submissions generated documents that nobody was told to
            // review. Confirmed in action_log before this fix.
            idempotency: { field: "service_delivery_id", value: deliveryId, workflow_slug: "itin_review" },
          })
          if (dispatch.spawned) {
            workflowSpawned = true
            results.push({ step: "task_created", status: "ok", detail: `Workflow ${dispatch.workflow_slug} task ${dispatch.task_id}` })
          } else if (dispatch.reason === "already_spawned") {
            workflowSpawned = true
            results.push({ step: "task_created", status: "skipped", detail: `Workflow task already exists for submission ${sub.id} (task ${dispatch.task_id})` })
          } else {
            console.warn(`[itin-form-completed] itin_review dispatch did not spawn (${dispatch.reason}): ${dispatch.meta_error ?? dispatch.spawn_error ?? ""} — falling back to plain task.`)
          }
        }

        // Defensive fallback: plain task (no workflow, no What's New note) when
        // there is no SD or the dispatch couldn't match/spawn.
        if (!workflowSpawned) {
          await dbWriteSafe(
            // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw tasks.insert; extract to lib/operations/ per dev_task fda76fd3
            supabaseAdmin.from("tasks").insert({
              task_title: taskTitle,
              description,
              assigned_to: defaultTaskAssignee(),
              priority: "High",
              category: "KYC",
              status: "To Do",
              due_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
              delivery_id: deliveryId || undefined,
              account_id: sub.account_id || undefined,
              contact_id: contactId || undefined,
              created_by: "System",
              // tasks.attachments is NOT NULL with no default — satisfy
              // explicitly so dbWriteSafe doesn't silently capture a 23502.
              attachments: [],
            }),
            "tasks.insert"
          )
          results.push({ step: "task_created", status: "ok", detail: `${taskTitle} (plain fallback)` })
        }
      }
    } catch (e) {
      results.push({ step: "task_created", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // --- STEP 7: Update SD history ---
    if (deliveryId) {
      try {
        const { data: sdRec } = await supabaseAdmin
          .from("service_deliveries").select("id, notes").eq("id", deliveryId).single()
        if (sdRec) {
          await dbWriteSafe(
            // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw service_deliveries.update; extract to lib/operations/ per dev_task fda76fd3
            supabaseAdmin.from("service_deliveries").update({
              notes: (sdRec.notes || "") + `\n${new Date().toISOString().split("T")[0]}: ITIN form completed. CRM updated. ${docsGenerated ? "W-7 + 1040-NR generated." : "Doc generation pending."} Luca notified.`,
              updated_at: new Date().toISOString(),
            }).eq("id", sdRec.id),
            "service_deliveries.update"
          )
        }
      } catch (e) {
        results.push({ step: "sd_history", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // --- STEP 8: Log action ---
    try {
      await dbWriteSafe(
        supabaseAdmin.from("action_log").insert({
          action_type: "itin_form_completed",
          table_name: "itin_submissions",
          record_id: submission_id,
          summary: `ITIN form completed: ${displayName}. ${docsGenerated ? "W-7 + 1040-NR generated." : "Doc generation pending."} Luca notified.`,
          details: { token, lead_id: sub.lead_id, contact_id: contactId, account_id: sub.account_id, docs_generated: docsGenerated, results } as unknown as Json,
        }),
        "action_log.insert"
      )
    } catch { /* non-blocking */ }

    // eslint-disable-next-line no-console
    console.log(`[itin-form-completed] ${displayName}: ${results.length} steps. ${results.filter(r => r.status === "ok").length} ok, ${results.filter(r => r.status === "error").length} errors`)

    return NextResponse.json({ ok: true, results })
  } catch (err) {
    console.error("[itin-form-completed]", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
