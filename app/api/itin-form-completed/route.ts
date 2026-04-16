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
 * 6. Email team with all data + "Documents generated, please review"
 * 7. Create task: "Review ITIN documents" assigned to Luca
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
import { APP_BASE_URL } from "@/lib/config"
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
    let clientEmail = ""
    if (sub.lead_id) {
      const { data: lead } = await supabaseAdmin.from("leads").select("full_name, email").eq("id", sub.lead_id).single()
      if (lead) { clientName = lead.full_name; clientEmail = lead.email || "" }
    } else if (sub.contact_id) {
      const { data: contact } = await supabaseAdmin.from("contacts").select("full_name, email").eq("id", sub.contact_id).single()
      if (contact) { clientName = contact.full_name; clientEmail = contact.email || "" } // eslint-disable-line @typescript-eslint/no-unused-vars
    }

    // Get company name if linked
    let companyName: string | null = null
    if (sub.account_id) {
      const { data: acc } = await supabaseAdmin.from("accounts").select("company_name").eq("id", sub.account_id).single()
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

      if (sub.account_id) {
        // Account-linked: use account's Drive folder
        const { data: acc } = await supabaseAdmin.from("accounts").select("drive_folder_id").eq("id", sub.account_id).single()
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
          const newSd = await createSD({
            service_type: "ITIN",
            service_name: `ITIN - ${clientName}`,
            account_id: sub.account_id || null,
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
    let docsGenerated = false
    try {
      // Import the prepare documents function from MCP tools
      // We call the same logic but directly, not via MCP
      // Try to import PDF generator — if not available, skip and create manual task
      let generateW7Pdf: ((data: Record<string, unknown>) => Promise<Buffer>) | null = null
      let generate1040NRPdf: ((data: Record<string, unknown>) => Promise<Buffer>) | null = null
      let generateScheduleOIPdf: ((data: Record<string, unknown>) => Promise<Buffer>) | null = null

      try {
        // Dynamic import with variable to prevent webpack static analysis
        const modPath = "@/lib/itin-pdf-generator"
        const mod = await import(/* webpackIgnore: true */ modPath)
        generateW7Pdf = mod.generateW7Pdf
        generate1040NRPdf = mod.generate1040NRPdf
        generateScheduleOIPdf = mod.generateScheduleOIPdf
      } catch {
        // PDF generator not yet extracted — will create manual task instead
      }

      if (generateW7Pdf && generate1040NRPdf && generateScheduleOIPdf && sd.first_name && sd.last_name) {
        const w7Buffer = await generateW7Pdf(sd)
        const nrBuffer = await generate1040NRPdf(sd)
        const oiBuffer = await generateScheduleOIPdf(sd)

        // Upload all 3 to Drive
        if (driveFolderId) {
          const { uploadBinaryToDrive, listFolder: lf, createFolder: cf } = await import("@/lib/google-drive")

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
          await uploadBinaryToDrive(`W-7_${slug}.pdf`, w7Buffer, "application/pdf", itinFolder.id)
          await uploadBinaryToDrive(`1040-NR_${slug}.pdf`, nrBuffer, "application/pdf", itinFolder.id)
          await uploadBinaryToDrive(`Schedule_OI_${slug}.pdf`, oiBuffer, "application/pdf", itinFolder.id)

          docsGenerated = true
          results.push({ step: "docs_generated", status: "ok", detail: `W-7 + 1040-NR + Schedule OI generated and uploaded to Drive/ITIN/` })
        }
      } else {
        results.push({ step: "docs_generated", status: "skipped", detail: "Missing name fields" })
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
<li>Client prints, signs, prints passport copies, mails to Largo FL</li>
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

    // --- STEP 6: Create task for Luca ---
    try {
      const taskTitle = docsGenerated
        ? `Review ITIN documents -- ${displayName}`
        : `Review ITIN form data -- ${displayName}`

      const { data: existingTask } = await supabaseAdmin
        .from("tasks").select("id").eq("task_title", taskTitle).maybeSingle()

      if (!existingTask) {
        await dbWriteSafe(
          supabaseAdmin.from("tasks").insert({
            task_title: taskTitle,
            description: docsGenerated
              ? `W-7 + 1040-NR + Schedule OI have been auto-generated for ${displayName}.\n\nReview the PDFs in Drive.\nIf correct, send to client: itin_prepare_documents(token="${token}", send_email=true)\nClient must print, sign in wet ink, print passport copies, and mail to Largo FL.`
              : `ITIN form completed for ${displayName}.\n\nDocument generation failed. Run manually:\n1. itin_form_review(token="${token}", apply_changes=true)\n2. itin_prepare_documents(token="${token}")`,
            assigned_to: "Luca",
            priority: "High",
            category: "KYC",
            status: "To Do",
            due_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
            delivery_id: deliveryId || undefined,
            account_id: sub.account_id || undefined,
            contact_id: contactId || undefined,
            created_by: "System",
          }),
          "tasks.insert"
        )
        results.push({ step: "task_created", status: "ok", detail: taskTitle })
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
