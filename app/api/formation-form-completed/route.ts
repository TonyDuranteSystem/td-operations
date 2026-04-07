/**
 * POST /api/formation-form-completed
 *
 * Called by the formation form frontend after the client submits.
 * Auto-chain per Company Formation SOP v5.0, Steps 21-22:
 *
 * 1. Validate submission
 * 2. Apply form data to CRM (update contact: DOB, nationality, address)
 * 3. Create Leads/{name}/ folder in Drive, upload data PDF + passport
 * 4. Check passport uploaded, flag if missing
 * 5. Check referral on lead -> create QB credit note task for Antonio
 * 6. Send Luca detailed email with all data + specific next steps
 * 7. Create task for Luca: "Verify data + check LLC name" (linked to delivery_id)
 * 8. Update service delivery stage_history
 * 9. Log everything (conv_log, action_log, account notes)
 *
 * Body: { submission_id: string, token: string }
 * No auth required (public endpoint -- only triggers internal notifications)
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { submission_id, token } = body as { submission_id?: string; token?: string }

    if (!submission_id || !token) {
      return NextResponse.json({ error: "submission_id and token required" }, { status: 400 })
    }

    // 1. Get submission
    const { data: sub, error: subErr } = await supabaseAdmin
      .from("formation_submissions")
      .select("*")
      .eq("id", submission_id)
      .eq("token", token)
      .single()

    if (subErr || !sub) {
      return NextResponse.json({ error: "Submission not found" }, { status: 404 })
    }

    if (sub.status !== "completed") {
      return NextResponse.json({ error: "Form not completed" }, { status: 400 })
    }

    const results: Array<{ step: string; status: string; detail?: string }> = []
    const submittedData = (sub.submitted_data || {}) as Record<string, unknown>
    const uploadPaths = (sub.upload_paths || []) as string[]
    const leadId = sub.lead_id as string | null

    // Get lead info
    let leadName = ""
    let leadEmail = ""
    let leadLanguage = "en"
    let referrerName = ""
    let contactId: string | null = null

    if (leadId) {
      const { data: lead } = await supabaseAdmin
        .from("leads")
        .select("full_name, email, phone, language, referrer_name, referrer_partner_id")
        .eq("id", leadId)
        .single()

      if (lead) {
        leadName = lead.full_name || ""
        leadEmail = lead.email || ""
        leadLanguage = lead.language === "Italian" || lead.language === "it" ? "it" : "en"
        referrerName = lead.referrer_name || ""
      }

      // Find contact linked to this lead
      const { data: contacts } = await supabaseAdmin
        .from("contacts")
        .select("id")
        .ilike("email", leadEmail || "noemail")
        .limit(1)

      if (contacts?.length) {
        contactId = contacts[0].id
      } else if (lead) {
        // AUTO-CREATE contact from lead data
        try {
          const { data: newContact } = await supabaseAdmin
            .from("contacts")
            .insert({
              full_name: lead.full_name,
              email: lead.email,
              phone: lead.phone,
              language: leadLanguage,
              role: "Owner",
            })
            .select("id")
            .single()

          if (newContact) {
            contactId = newContact.id
            results.push({ step: "contact_created", status: "ok", detail: `Contact auto-created: ${contactId}` })
          }
        } catch (e) {
          results.push({ step: "contact_created", status: "error", detail: e instanceof Error ? e.message : String(e) })
        }
      }
    }

    // ─── STEP 1B: Ensure Service Delivery exists ───
    let deliveryId: string | null = null
    try {
      // Check by contact_id or notes containing token
      const orFilters = [`notes.ilike.%${token}%`]
      if (contactId) orFilters.push(`contact_id.eq.${contactId}`)

      const { data: existingSd } = await supabaseAdmin
        .from("service_deliveries")
        .select("id")
        .eq("service_type", "Company Formation")
        .or(orFilters.join(","))
        .eq("status", "active")
        .limit(1)

      if (existingSd?.length) {
        deliveryId = existingSd[0].id
      } else {
        // AUTO-CREATE Service Delivery
        const { data: stages } = await supabaseAdmin
          .from("pipeline_stages")
          .select("stage_name")
          .eq("service_type", "Company Formation")
          .order("stage_order")
          .limit(1)

        const firstStage = stages?.[0]?.stage_name || "Data Collection"
        const llcName = submittedData.llc_name_1 || submittedData.preferred_name_1 || "New LLC"

        const { data: newSd } = await supabaseAdmin
          .from("service_deliveries")
          .insert({
            service_type: "Company Formation",
            service_name: `Company Formation - ${leadName} (${llcName})`,
            contact_id: contactId,
            current_stage: firstStage,
            status: "active",
            assigned_to: "Luca",
            notes: `Auto-created from formation form ${token}`,
          })
          .select("id")
          .single()

        if (newSd) {
          deliveryId = newSd.id
          results.push({ step: "sd_created", status: "ok", detail: `SD auto-created: ${deliveryId}` })
        }
      }
    } catch (e) {
      results.push({ step: "sd_check", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // ─── STEP 2: Apply form data to CRM (update contact) ───
    if (contactId) {
      try {
        const updates: Record<string, unknown> = {}
        if (submittedData.owner_dob) updates.date_of_birth = submittedData.owner_dob
        if (submittedData.owner_nationality) updates.citizenship = submittedData.owner_nationality
        if (submittedData.owner_phone) updates.phone = submittedData.owner_phone

        // Build full address from parts
        const addressParts = [
          submittedData.owner_street,
          submittedData.owner_city,
          submittedData.owner_state,
          submittedData.owner_zip,
          submittedData.owner_country,
        ].filter(Boolean)
        if (addressParts.length > 0) updates.residency = addressParts.join(", ")

        // Check passport
        const hasPassport = uploadPaths.some(p => p.toLowerCase().includes("passport"))
        if (hasPassport) updates.passport_on_file = true

        if (Object.keys(updates).length > 0) {
          updates.updated_at = new Date().toISOString()
          await supabaseAdmin
            .from("contacts")
            .update(updates)
            .eq("id", contactId)

          results.push({ step: "crm_update", status: "ok", detail: `Contact updated: ${Object.keys(updates).join(", ")}` })
        }
      } catch (e) {
        results.push({ step: "crm_update", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    } else {
      results.push({ step: "crm_update", status: "skipped", detail: "No contact found for lead" })
    }

    // ─── STEP 3: Create Leads/{name}/ folder in Drive + save data PDF ───
    let leadsFolderId = ""
    try {
      const { listFolder, createFolder } = await import("@/lib/google-drive")
      const { saveFormToDrive } = await import("@/lib/form-to-drive")

      // Find or create Leads/ folder in Shared Drive root
      const TD_CLIENTS_FOLDER = "1mbz_bUDwC4K259RcC-tDKihjlvdAVXno" // TD Clients folder on Shared Drive
      const clientsContents = await listFolder(TD_CLIENTS_FOLDER) as { files?: { id: string; name: string; mimeType: string }[] }
      let leadsParent = clientsContents?.files?.find(
        (f: { name: string; mimeType: string }) => f.name === "Leads" && f.mimeType === "application/vnd.google-apps.folder"
      )

      if (!leadsParent) {
        const newFolder = await createFolder(TD_CLIENTS_FOLDER, "Leads")
        leadsParent = { id: newFolder.id, name: "Leads", mimeType: "application/vnd.google-apps.folder" }
      }

      // Create client folder: Leads/{Client Name}/
      const clientFolderName = leadName || token
      const leadsContents = await listFolder(leadsParent.id) as { files?: { id: string; name: string; mimeType: string }[] }
      let clientFolder = leadsContents?.files?.find(
        (f: { name: string; mimeType: string }) => f.name === clientFolderName && f.mimeType === "application/vnd.google-apps.folder"
      )

      if (!clientFolder) {
        const newFolder = await createFolder(leadsParent.id, clientFolderName)
        clientFolder = { id: newFolder.id, name: clientFolderName, mimeType: "application/vnd.google-apps.folder" }
      }

      leadsFolderId = clientFolder.id

      // Save data summary PDF + copy uploads to Leads folder
      const driveResult = await saveFormToDrive(
        "formation",
        submittedData,
        uploadPaths,
        leadsFolderId,
        { token, submittedAt: sub.completed_at || new Date().toISOString(), companyName: leadName }
      )

      results.push({
        step: "drive_save",
        status: "ok",
        detail: `Folder: Leads/${clientFolderName}/. Summary: ${driveResult.summaryFileId ? "saved" : "failed"}. Files: ${driveResult.copied.length} copied.`,
      })
    } catch (e) {
      results.push({ step: "drive_save", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // ─── STEP 4: Check passport uploaded ───
    const hasPassport = uploadPaths.some(p => p.toLowerCase().includes("passport"))
    if (!hasPassport) {
      results.push({ step: "passport_check", status: "missing", detail: "No passport uploaded. Task will be created to request it." })
    } else {
      results.push({ step: "passport_check", status: "ok", detail: "Passport uploaded" })
    }

    // ─── STEP 5: Check referral ───
    if (referrerName && leadId) {
      try {
        // Find referrer's contact and account
        const { data: refContacts } = await supabaseAdmin
          .from("contacts")
          .select("id, full_name, account_contacts(account_id, accounts(id, company_name))")
          .ilike("full_name", `%${referrerName}%`)
          .limit(1)

        let refCompanyName = ""
        let refAccountId = ""

        if (refContacts?.length) {
          const ac = refContacts[0].account_contacts as unknown as Array<{ account_id: string; accounts: { id: string; company_name: string } | Array<{ id: string; company_name: string }> }> | null
          if (ac?.length) {
            const accts = ac[0].accounts
            if (Array.isArray(accts) && accts.length > 0) {
              refCompanyName = accts[0].company_name
              refAccountId = accts[0].id
            } else if (accts && !Array.isArray(accts)) {
              refCompanyName = (accts as { company_name: string }).company_name
              refAccountId = (accts as { id: string }).id
            }
          }
        }

        if (refCompanyName) {
          // Create task for Antonio to approve credit note
          const { data: task } = await supabaseAdmin
            .from("tasks")
            .insert({
              task_title: `[REFERRAL] Approve credit note for ${refCompanyName}`,
              description: `Referrer: ${referrerName} (${refCompanyName})\nReferred client: ${leadName}\nPayment: EUR 3,000 (check actual amount on offer)\nCommission: 10% = EUR 300 (verify percentage)\n\nCreate QB credit note for ${refCompanyName} once approved.\nUse: qb_create_invoice with negative amount or credit memo.`,
              assigned_to: "Antonio",
              priority: "High",
              category: "Payment",
              status: "To Do",
              account_id: refAccountId || null,
              created_by: "System",
            })
            .select("id")
            .single()

          // Send notification email to Antonio
          try {
            const { gmailPost } = await import("@/lib/gmail")
            const referralSubject = `[REFERRAL] Credit note needed - ${refCompanyName} referred ${leadName}`
            const encodedReferralSubject = `=?utf-8?B?${Buffer.from(referralSubject).toString("base64")}?=`
            const raw = Buffer.from(
              `From: Tony Durante CRM <support@tonydurante.us>\r\n` +
              `To: antonio.durante@tonydurante.us\r\n` +
              `Subject: ${encodedReferralSubject}\r\n` +
              `MIME-Version: 1.0\r\n` +
              `Content-Type: text/html; charset=utf-8\r\n\r\n` +
              `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6">` +
              `<h2>[REFERRAL] Credit Note Approval</h2>` +
              `<p><strong>Referrer:</strong> ${referrerName} (${refCompanyName})</p>` +
              `<p><strong>Referred client:</strong> ${leadName}</p>` +
              `<p><strong>Commission:</strong> 10% (verify on offer)</p>` +
              `<p>Approve the credit note and I will create it in QuickBooks.</p>` +
              `<p style="font-size:12px;color:#6b7280">Task ID: ${task?.id || "N/A"}</p>` +
              `</div>`
            ).toString("base64url")
            await gmailPost("/messages/send", { raw })
          } catch { /* email notification non-blocking */ }

          results.push({ step: "referral", status: "ok", detail: `Referrer: ${referrerName} (${refCompanyName}). Task created for Antonio.` })
        } else {
          results.push({ step: "referral", status: "warning", detail: `Referrer "${referrerName}" found but no company linked. Create credit note manually.` })
        }
      } catch (e) {
        results.push({ step: "referral", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ─── STEP 6: Send Luca detailed email with next steps ───
    try {
      const { gmailPost } = await import("@/lib/gmail")

      const llcName1 = submittedData.llc_name_1 || submittedData.preferred_name_1 || "N/A"
      const llcName2 = submittedData.llc_name_2 || submittedData.preferred_name_2 || "N/A"
      const llcName3 = submittedData.llc_name_3 || submittedData.preferred_name_3 || "N/A"
      const state = sub.state || "NM"
      const entityType = sub.entity_type || "SMLLC"

      const emailBody = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a">
<h2>[TASK] New Formation - Data Received</h2>
<p>The client <strong>${leadName}</strong> has completed the formation data collection form.</p>

<h3>Client Information</h3>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:4px 8px;font-weight:bold">Name:</td><td style="padding:4px 8px">${submittedData.owner_first_name || ""} ${submittedData.owner_last_name || ""}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Email:</td><td style="padding:4px 8px">${leadEmail}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Phone:</td><td style="padding:4px 8px">${submittedData.owner_phone || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">DOB:</td><td style="padding:4px 8px">${submittedData.owner_dob || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Nationality:</td><td style="padding:4px 8px">${submittedData.owner_nationality || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Address:</td><td style="padding:4px 8px">${submittedData.owner_street || ""}, ${submittedData.owner_city || ""}, ${submittedData.owner_state || ""} ${submittedData.owner_zip || ""}, ${submittedData.owner_country || ""}</td></tr>
</table>

<h3>LLC Details</h3>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:4px 8px;font-weight:bold">1st choice:</td><td style="padding:4px 8px"><strong>${llcName1}</strong></td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">2nd choice:</td><td style="padding:4px 8px">${llcName2}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">3rd choice:</td><td style="padding:4px 8px">${llcName3}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Entity:</td><td style="padding:4px 8px">${entityType}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">State:</td><td style="padding:4px 8px">${state}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Purpose:</td><td style="padding:4px 8px">${submittedData.business_purpose || submittedData.llc_purpose || "N/A"}</td></tr>
</table>

<h3>Documents</h3>
<p>Passport: <strong style="color:${hasPassport ? "#16a34a" : "#dc2626"}">${hasPassport ? "UPLOADED" : "MISSING - request from client"}</strong></p>
${uploadPaths.length > 0 ? `<p>Files uploaded: ${uploadPaths.map(p => p.split("/").pop()).join(", ")}</p>` : ""}

<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/>

<h3>Next Steps</h3>
<ol>
<li>Verify the data above is correct</li>
<li>Go to the <strong>${state}</strong> Secretary of State portal</li>
<li>Check if "<strong>${llcName1}</strong>" is available</li>
<li>If available, confirm with client and file Articles of Organization</li>
<li>If not available, try "${llcName2}" or "${llcName3}"</li>
${!hasPassport ? `<li style="color:#dc2626"><strong>REQUEST PASSPORT from client via email</strong></li>` : ""}
</ol>

<p style="font-size:12px;color:#6b7280">Form token: ${token} | Lead: ${leadName}</p>
</div>`

      const formationSubject = `[TASK] Formation data received - ${leadName} - ${llcName1}`
      const encodedSubject = `=?utf-8?B?${Buffer.from(formationSubject).toString("base64")}?=`
      const raw = Buffer.from(
        `From: Tony Durante CRM <support@tonydurante.us>\r\n` +
        `To: support@tonydurante.us\r\n` +
        `Subject: ${encodedSubject}\r\n` +
        `MIME-Version: 1.0\r\n` +
        `Content-Type: text/html; charset=utf-8\r\n\r\n` +
        emailBody
      ).toString("base64url")

      await gmailPost("/messages/send", { raw })
      results.push({ step: "luca_email", status: "ok", detail: "Detailed email sent to support@tonydurante.us" })
    } catch (e) {
      results.push({ step: "luca_email", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // ─── STEP 7: Create task for Luca ───
    try {
      const llcName1 = submittedData.llc_name_1 || submittedData.preferred_name_1 || "N/A"
      // deliveryId already resolved in Step 1B above

      const { data: task } = await supabaseAdmin
        .from("tasks")
        .insert({
          task_title: `Verify data + check LLC name: ${leadName} - ${llcName1}`,
          description: `Formation form completed for ${leadName}.\n\nLLC 1st choice: ${llcName1}\nState: ${sub.state || "NM"}\nEntity: ${sub.entity_type || "SMLLC"}\n${!hasPassport ? "\n** PASSPORT MISSING - request from client **\n" : ""}\nSteps:\n1. Verify data is correct\n2. Check "${llcName1}" availability on ${sub.state || "NM"} SOS portal\n3. If available, confirm with client\n4. Mark this task as Done to advance pipeline`,
          assigned_to: "Luca",
          priority: "High",
          category: "Formation",
          status: "To Do",
          due_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
          delivery_id: deliveryId || null,
          contact_id: contactId || null,
          created_by: "System",
        })
        .select("id")
        .single()

      results.push({ step: "luca_task", status: "ok", detail: `Task created: ${task?.id}. Delivery: ${deliveryId || "none"}` })

      // Also create passport request task if missing
      if (!hasPassport) {
        await supabaseAdmin
          .from("tasks")
          .insert({
            task_title: `[MISSING] Request passport from ${leadName}`,
            description: `The formation form was submitted WITHOUT a passport.\nEmail the client at ${leadEmail} to request a clear passport scan.\nUse email only, never WhatsApp for official documents.`,
            assigned_to: "Luca",
            priority: "Urgent",
            category: "Document",
            status: "To Do",
            due_date: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
            delivery_id: deliveryId || null,
            contact_id: contactId || null,
            created_by: "System",
          })

        results.push({ step: "passport_task", status: "ok", detail: "Urgent task created to request passport" })
      }
    } catch (e) {
      results.push({ step: "luca_task", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // ─── STEP 8: Update service delivery history ───
    if (deliveryId) {
      try {
        const { data: sd } = await supabaseAdmin
          .from("service_deliveries")
          .select("id, notes")
          .eq("id", deliveryId)
          .single()

        if (sd) {
          const currentNotes = sd.notes || ""
          await supabaseAdmin
            .from("service_deliveries")
            .update({
              notes: currentNotes + `\n${new Date().toISOString().split("T")[0]}: Formation form completed. Data applied to CRM. Luca notified.`,
              updated_at: new Date().toISOString(),
            })
            .eq("id", sd.id)

          results.push({ step: "sd_update", status: "ok", detail: `SD ${sd.id} notes updated` })
        } else {
          results.push({ step: "sd_update", status: "skipped", detail: "SD not found" })
        }
      } catch (e) {
        results.push({ step: "sd_update", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ─── STEP 9: Log action ───
    try {
      await supabaseAdmin.from("action_log").insert({
        action_type: "formation_form_completed",
        entity_type: "formation_submissions",
        entity_id: submission_id,
        summary: `Formation form completed: ${leadName}. CRM updated, Drive saved, Luca notified.`,
        details: { token, lead_id: leadId, contact_id: contactId, results },
      })
    } catch { /* non-blocking */ }

    // eslint-disable-next-line no-console
    console.log(`[formation-form-completed] ${leadName}: ${results.length} steps. ${results.filter(r => r.status === "ok").length} ok, ${results.filter(r => r.status === "error").length} errors`)

    return NextResponse.json({ ok: true, results })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[formation-form-completed] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
