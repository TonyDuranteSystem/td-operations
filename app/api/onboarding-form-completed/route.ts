/**
 * POST /api/onboarding-form-completed
 *
 * Called by the onboarding form frontend after the client submits.
 * Auto-chain per Client Onboarding SOP v5.0:
 *
 * 1. Validate submission
 * 2. Apply form data to CRM (update contact: DOB, nationality, address, passport)
 * 3. Create Leads/{name}/ folder in Drive, upload data PDF + documents
 * 4. Check passport uploaded, flag if missing
 * 5. Check referral on lead -> create QB credit note task for Antonio
 * 6. Send Luca detailed email with all data + specific next steps
 * 7. Create task for Luca: "Review onboarding data + verify LLC info" (linked to delivery_id)
 * 8. Update service delivery stage_history
 * 9. Log everything (action_log)
 *
 * Body: { submission_id: string, token: string }
 * No auth required (public endpoint -- only triggers internal notifications)
 */

// Added 2026-04-14 P0.7: protect the 9-step auto-chain from mid-execution
// Vercel timeout (CRM update + Drive folder + PDF + email + task + SD history + log).
export const maxDuration = 60

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
      .from("onboarding_submissions")
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

    // ---- STEP 1B: Ensure Service Delivery exists ----
    let deliveryId: string | null = null
    try {
      const orFilters = [`notes.ilike.%${token}%`]
      if (contactId) orFilters.push(`contact_id.eq.${contactId}`)

      const { data: existingSd } = await supabaseAdmin
        .from("service_deliveries")
        .select("id")
        .eq("service_type", "Client Onboarding")
        .or(orFilters.join(","))
        .eq("status", "active")
        .limit(1)

      if (existingSd?.length) {
        deliveryId = existingSd[0].id
      } else {
        const { data: stages } = await supabaseAdmin
          .from("pipeline_stages")
          .select("stage_name")
          .eq("service_type", "Client Onboarding")
          .order("stage_order")
          .limit(1)

        const firstStage = stages?.[0]?.stage_name || "Data Collection"
        const companyName = submittedData.company_name || "Existing LLC"

        const { data: newSd } = await supabaseAdmin
          .from("service_deliveries")
          .insert({
            service_type: "Client Onboarding",
            service_name: `Client Onboarding - ${leadName} (${companyName})`,
            contact_id: contactId,
            current_stage: firstStage,
            status: "active",
            assigned_to: "Luca",
            notes: `Auto-created from onboarding form ${token}`,
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

    // ---- STEP 2: Apply form data to CRM (update contact) ----
    if (contactId) {
      try {
        const updates: Record<string, unknown> = {}
        if (submittedData.owner_dob) updates.date_of_birth = submittedData.owner_dob
        if (submittedData.owner_nationality) updates.citizenship = submittedData.owner_nationality
        if (submittedData.owner_phone) updates.phone = submittedData.owner_phone

        const addressParts = [
          submittedData.owner_street,
          submittedData.owner_city,
          submittedData.owner_state,
          submittedData.owner_zip,
          submittedData.owner_country,
        ].filter(Boolean)
        if (addressParts.length > 0) updates.residency = addressParts.join(", ")

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
    }

    // ---- STEP 3: Create Leads/{name}/ folder in Drive + save data PDF ----
    try {
      const { listFolder, createFolder } = await import("@/lib/google-drive")
      const { saveFormToDrive } = await import("@/lib/form-to-drive")

      const TD_CLIENTS_FOLDER = "1mbz_bUDwC4K259RcC-tDKihjlvdAVXno"
      const clientsContents = await listFolder(TD_CLIENTS_FOLDER) as { files?: { id: string; name: string; mimeType: string }[] }
      let leadsParent = clientsContents?.files?.find(
        (f: { name: string; mimeType: string }) => f.name === "Leads" && f.mimeType === "application/vnd.google-apps.folder"
      )

      if (!leadsParent) {
        const newFolder = await createFolder(TD_CLIENTS_FOLDER, "Leads")
        leadsParent = { id: newFolder.id, name: "Leads", mimeType: "application/vnd.google-apps.folder" }
      }

      const clientFolderName = leadName || String(submittedData.company_name) || token
      const leadsContents = await listFolder(leadsParent.id) as { files?: { id: string; name: string; mimeType: string }[] }
      let clientFolder = leadsContents?.files?.find(
        (f: { name: string; mimeType: string }) => f.name === clientFolderName && f.mimeType === "application/vnd.google-apps.folder"
      )

      if (!clientFolder) {
        const newFolder = await createFolder(leadsParent.id, clientFolderName)
        clientFolder = { id: newFolder.id, name: clientFolderName, mimeType: "application/vnd.google-apps.folder" }
      }

      const driveResult = await saveFormToDrive(
        "onboarding",
        submittedData,
        uploadPaths,
        clientFolder.id,
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

    // ---- STEP 4: Check passport ----
    const hasPassport = uploadPaths.some(p => p.toLowerCase().includes("passport"))
    results.push({
      step: "passport_check",
      status: hasPassport ? "ok" : "missing",
      detail: hasPassport ? "Passport uploaded" : "No passport uploaded. Task will be created.",
    })

    // ---- STEP 5: Check referral ----
    if (referrerName && leadId) {
      try {
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
          await supabaseAdmin
            .from("tasks")
            .insert({
              task_title: `[REFERRAL] Approve credit note for ${refCompanyName}`,
              description: `Referrer: ${referrerName} (${refCompanyName})\nReferred client: ${leadName}\nCommission: 10% (verify on offer)\n\nCreate QB credit note for ${refCompanyName} once approved.`,
              assigned_to: "Antonio",
              priority: "High",
              category: "Payment",
              status: "To Do",
              account_id: refAccountId || null,
              created_by: "System",
            })

          results.push({ step: "referral", status: "ok", detail: `Referrer: ${referrerName} (${refCompanyName}). Task created for Antonio.` })
        }
      } catch (e) {
        results.push({ step: "referral", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ---- STEP 6: Send Luca detailed email ----
    try {
      const { gmailPost } = await import("@/lib/gmail")

      const companyName = submittedData.company_name || "N/A"
      const state = submittedData.state || sub.state || "N/A"
      const entityType = sub.entity_type || "SMLLC"
      const ein = submittedData.ein || "N/A"
      const formationDate = submittedData.formation_date || "N/A"
      const taxPrevYear = submittedData.tax_return_previous_year_filed || "N/A"
      const taxCurrYear = submittedData.tax_return_current_year_filed || "N/A"

      const emailBody = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a">
<h2>[TASK] New Onboarding - Data Received</h2>
<p>The client <strong>${leadName}</strong> has completed the onboarding data collection form.</p>

<h3>Client Information</h3>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:4px 8px;font-weight:bold">Name:</td><td style="padding:4px 8px">${submittedData.owner_first_name || ""} ${submittedData.owner_last_name || ""}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Email:</td><td style="padding:4px 8px">${leadEmail}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Phone:</td><td style="padding:4px 8px">${submittedData.owner_phone || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">DOB:</td><td style="padding:4px 8px">${submittedData.owner_dob || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Nationality:</td><td style="padding:4px 8px">${submittedData.owner_nationality || "N/A"}</td></tr>
</table>

<h3>LLC Details</h3>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:4px 8px;font-weight:bold">Company:</td><td style="padding:4px 8px"><strong>${companyName}</strong></td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">State:</td><td style="padding:4px 8px">${state}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Entity:</td><td style="padding:4px 8px">${entityType}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">EIN:</td><td style="padding:4px 8px">${ein}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Formation Date:</td><td style="padding:4px 8px">${formationDate}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Tax Return (prev year):</td><td style="padding:4px 8px">${taxPrevYear}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Tax Return (curr year):</td><td style="padding:4px 8px">${taxCurrYear}</td></tr>
</table>

<h3>Documents</h3>
<p>Passport: <strong style="color:${hasPassport ? "#16a34a" : "#dc2626"}">${hasPassport ? "UPLOADED" : "MISSING - request from client"}</strong></p>
${uploadPaths.length > 0 ? `<p>Files uploaded: ${uploadPaths.map(p => p.split("/").pop()).join(", ")}</p>` : ""}

<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/>

<h3>Next Steps</h3>
<ol>
<li>Verify the data above is correct</li>
<li>Run <code>onboarding_form_review(token="${token}", apply_changes=true)</code> to set up CRM</li>
<li>This will auto-create Account, Drive folder, lease draft, and follow-up tasks</li>
<li>Start RA change on Harbor Compliance</li>
${!hasPassport ? `<li style="color:#dc2626"><strong>REQUEST PASSPORT from client via email</strong></li>` : ""}
${taxPrevYear === "no" || taxCurrYear === "no" ? `<li style="color:#d97706"><strong>TAX RETURN NEEDED - check if tax return service should be created</strong></li>` : ""}
</ol>

<p style="font-size:12px;color:#6b7280">Form token: ${token} | Lead: ${leadName}</p>
</div>`

      const onboardingSubject = `[TASK] Onboarding data received - ${leadName} - ${companyName}`
      const encodedSubject = `=?utf-8?B?${Buffer.from(onboardingSubject).toString("base64")}?=`
      const raw = Buffer.from(
        `From: Tony Durante CRM <support@tonydurante.us>\r\n` +
        `To: support@tonydurante.us\r\n` +
        `Subject: ${encodedSubject}\r\n` +
        `MIME-Version: 1.0\r\n` +
        `Content-Type: text/html; charset=utf-8\r\n\r\n` +
        emailBody
      ).toString("base64url")

      await gmailPost("/messages/send", { raw })
      results.push({ step: "luca_email", status: "ok", detail: "Detailed email sent to support@" })
    } catch (e) {
      results.push({ step: "luca_email", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // ---- STEP 7: Create task for Luca ----
    try {
      const companyName = submittedData.company_name || "Existing LLC"

      const { data: task } = await supabaseAdmin
        .from("tasks")
        .insert({
          task_title: `Review onboarding data: ${leadName} - ${companyName}`,
          description: `Onboarding form completed for ${leadName}.\n\nCompany: ${companyName}\nState: ${submittedData.state || sub.state || "N/A"}\nEIN: ${submittedData.ein || "N/A"}\n${!hasPassport ? "\n** PASSPORT MISSING - request from client **\n" : ""}\nSteps:\n1. Verify data is correct\n2. Run onboarding_form_review(token="${token}", apply_changes=true)\n3. Start RA change on Harbor Compliance\n4. Mark this task as Done when CRM setup is complete`,
          assigned_to: "Luca",
          priority: "High",
          category: "Onboarding",
          status: "To Do",
          due_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
          delivery_id: deliveryId || null,
          contact_id: contactId || null,
          created_by: "System",
        })
        .select("id")
        .single()

      results.push({ step: "luca_task", status: "ok", detail: `Task created: ${task?.id}. Delivery: ${deliveryId || "none"}` })

      if (!hasPassport) {
        await supabaseAdmin
          .from("tasks")
          .insert({
            task_title: `[MISSING] Request passport from ${leadName}`,
            description: `The onboarding form was submitted WITHOUT a passport.\nEmail the client at ${leadEmail} to request a clear passport scan.\nUse email only, never WhatsApp for official documents.`,
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

    // ---- STEP 8: Update service delivery history ----
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
              notes: currentNotes + `\n${new Date().toISOString().split("T")[0]}: Onboarding form completed. Data applied to CRM. Luca notified.`,
              updated_at: new Date().toISOString(),
            })
            .eq("id", sd.id)
          results.push({ step: "sd_update", status: "ok", detail: `SD ${sd.id} notes updated` })
        }
      } catch (e) {
        results.push({ step: "sd_update", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ---- STEP 9: Log action ----
    try {
      await supabaseAdmin.from("action_log").insert({
        action_type: "onboarding_form_completed",
        entity_type: "onboarding_submissions",
        entity_id: submission_id,
        summary: `Onboarding form completed: ${leadName}. CRM updated, Drive saved, Luca notified.`,
        details: { token, lead_id: leadId, contact_id: contactId, results },
      })
    } catch { /* non-blocking */ }

    // eslint-disable-next-line no-console
    console.log(`[onboarding-form-completed] ${leadName}: ${results.length} steps. ${results.filter(r => r.status === "ok").length} ok, ${results.filter(r => r.status === "error").length} errors`)

    return NextResponse.json({ ok: true, results })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[onboarding-form-completed] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
