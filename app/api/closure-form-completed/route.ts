/**
 * POST /api/closure-form-completed
 *
 * Called by the closure form frontend after the client submits.
 * Auto-chain per Company Closure SOP:
 *
 * 1. Validate submission
 * 2. Create Leads/{name}/ folder in Drive, upload data PDF + documents
 * 3. Send Luca detailed email with LLC details + specific next steps
 * 4. Create task for Luca: "Start closure compliance check" (linked to delivery_id)
 * 5. Ensure Service Delivery exists
 * 6. Update service delivery stage_history
 * 7. Log everything (action_log)
 *
 * Body: { submission_id: string, token: string }
 * No auth required (public endpoint -- only triggers internal notifications)
 */

// Added 2026-04-14 P0.7: protect the 7-step auto-chain from mid-execution
// Vercel timeout (Drive folder + PDF + email + task + SD ensure + history + log).
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { dbWriteSafe } from "@/lib/db"
import { createSD } from "@/lib/operations/service-delivery"
import type { Json } from "@/lib/database.types"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { submission_id, token } = body as { submission_id?: string; token?: string }

    if (!submission_id || !token) {
      return NextResponse.json({ error: "submission_id and token required" }, { status: 400 })
    }

    // 1. Get submission
    const { data: sub, error: subErr } = await supabaseAdmin
      .from("closure_submissions")
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
    const contactId = sub.contact_id as string | null
    const accountId = sub.account_id as string | null

    // Get client name
    let clientName = String(submittedData.owner_name || submittedData.owner_first_name || "")
    if (submittedData.owner_last_name) clientName += ` ${submittedData.owner_last_name}`
    if (!clientName.trim()) {
      if (leadId) {
        const { data: lead } = await supabaseAdmin.from("leads").select("full_name").eq("id", leadId).single()
        clientName = lead?.full_name || token
      } else if (contactId) {
        const { data: contact } = await supabaseAdmin.from("contacts").select("full_name").eq("id", contactId).single()
        clientName = contact?.full_name || token
      }
    }
    clientName = clientName.trim() || token

    const llcName = String(submittedData.llc_name || "Unknown LLC")
    const llcEin = String(submittedData.llc_ein || "N/A")
    const llcState = String(submittedData.llc_state || (sub as Record<string, unknown>).state || "N/A")
    const formationYear = String(submittedData.formation_year || "N/A")
    const taxFiled = String(submittedData.tax_returns_filed || "N/A")
    const taxYears = String(submittedData.tax_returns_years || "N/A")
    const registeredAgent = String(submittedData.registered_agent || "N/A")

    // ---- STEP 2: Save to Drive ----
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

      // Use LLC name as folder name for closure
      const clientFolderName = `${clientName} - ${llcName} (Closure)`
      const leadsContents = await listFolder(leadsParent.id) as { files?: { id: string; name: string; mimeType: string }[] }
      let clientFolder = leadsContents?.files?.find(
        (f: { name: string; mimeType: string }) => f.name === clientFolderName && f.mimeType === "application/vnd.google-apps.folder"
      )

      if (!clientFolder) {
        const newFolder = await createFolder(leadsParent.id, clientFolderName)
        clientFolder = { id: newFolder.id, name: clientFolderName, mimeType: "application/vnd.google-apps.folder" }
      }

      // If account has a Drive folder, use that instead
      let targetFolderId = clientFolder.id
      if (accountId) {
        const { data: acc } = await supabaseAdmin.from("accounts").select("drive_folder_id").eq("id", accountId).single()
        if (acc?.drive_folder_id) targetFolderId = acc.drive_folder_id
      }

      const driveResult = await saveFormToDrive(
        "closure",
        submittedData,
        uploadPaths,
        targetFolderId,
        { token, submittedAt: sub.completed_at || new Date().toISOString(), companyName: llcName }
      )

      results.push({
        step: "drive_save",
        status: "ok",
        detail: `Summary: ${driveResult.summaryFileId ? "saved" : "failed"}. Files: ${driveResult.copied.length} copied.`,
      })
    } catch (e) {
      results.push({ step: "drive_save", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // ---- STEP 3: Ensure Service Delivery exists ----
    let deliveryId: string | null = null
    try {
      const orFilters = [`notes.ilike.%${token}%`]
      if (accountId) orFilters.push(`account_id.eq.${accountId}`)
      if (contactId) orFilters.push(`contact_id.eq.${contactId}`)

      const { data: existingSd } = await supabaseAdmin
        .from("service_deliveries")
        .select("id")
        .eq("service_type", "Company Closure")
        .or(orFilters.join(","))
        .eq("status", "active")
        .limit(1)

      if (existingSd?.length) {
        deliveryId = existingSd[0].id
      } else {
        const newSd = await createSD({
          service_type: "Company Closure",
          service_name: `Company Closure - ${llcName}`,
          account_id: accountId,
          contact_id: contactId,
          notes: `Auto-created from closure form ${token}`,
        })
        deliveryId = newSd.id
        results.push({ step: "sd_created", status: "ok", detail: `SD auto-created: ${deliveryId}` })
      }
    } catch (e) {
      results.push({ step: "sd_check", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // ---- STEP 4: Send Luca detailed email ----
    try {
      const { gmailPost } = await import("@/lib/gmail")

      const emailBody = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a">
<h2>[TASK] New Closure Request - Data Received</h2>
<p>The client <strong>${clientName}</strong> has submitted a company closure request.</p>

<h3>LLC Details</h3>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:4px 8px;font-weight:bold">LLC Name:</td><td style="padding:4px 8px"><strong>${llcName}</strong></td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">EIN:</td><td style="padding:4px 8px">${llcEin}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">State:</td><td style="padding:4px 8px">${llcState}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Formation Year:</td><td style="padding:4px 8px">${formationYear}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Registered Agent:</td><td style="padding:4px 8px">${registeredAgent}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Tax Returns Filed:</td><td style="padding:4px 8px">${taxFiled}${taxFiled === "yes" ? ` (Years: ${taxYears})` : ""}</td></tr>
</table>

<h3>Documents Uploaded</h3>
<p>${uploadPaths.length > 0 ? uploadPaths.map(p => p.split("/").pop()).join(", ") : "None"}</p>

<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/>

<h3>Next Steps (Company Closure SOP)</h3>
<ol>
<li>Verify the LLC details above are correct</li>
<li><strong>State Compliance Check:</strong> Check outstanding taxes, unpaid fees, annual report status for ${llcState}</li>
<li>Resolve any outstanding obligations before filing dissolution</li>
<li>Prepare Articles of Dissolution (${llcState}) -- use <code>closure_prepare_documents(token="${token}", state="${llcState}")</code></li>
${taxFiled === "no" ? `<li style="color:#d97706"><strong>FINAL TAX RETURN may be needed -- client says no tax returns were filed</strong></li>` : ""}
</ol>

<p style="font-size:12px;color:#6b7280">Form token: ${token} | Client: ${clientName} | LLC: ${llcName}</p>
</div>`

      const closureSubject = `[TASK] Closure request received - ${llcName} (${llcState})`
      const encodedSubject = `=?utf-8?B?${Buffer.from(closureSubject).toString("base64")}?=`
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

    // ---- STEP 5: Create task for Luca ----
    try {
      await dbWriteSafe(
        supabaseAdmin
          .from("tasks")
          .insert({
            task_title: `Start closure: ${llcName} (${llcState})`,
            description: `Closure form completed for ${clientName}.\n\nLLC: ${llcName}\nState: ${llcState}\nEIN: ${llcEin}\nFormation: ${formationYear}\nTax Filed: ${taxFiled}\n\nSteps:\n1. State compliance check (outstanding taxes, fees, annual reports)\n2. Resolve any outstanding obligations\n3. Prepare Articles of Dissolution\n4. Mark this task as Done to advance pipeline`,
            assigned_to: "Luca",
            priority: "High",
            category: "Filing",
            status: "To Do",
            due_date: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
            delivery_id: deliveryId || null,
            account_id: accountId || null,
            contact_id: contactId || null,
            created_by: "System",
          }),
        "tasks.insert"
      )

      results.push({ step: "luca_task", status: "ok", detail: `Task created. Delivery: ${deliveryId || "none"}` })
    } catch (e) {
      results.push({ step: "luca_task", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // ---- STEP 6: Update service delivery ----
    if (deliveryId) {
      try {
        const { data: sd } = await supabaseAdmin
          .from("service_deliveries")
          .select("id, notes")
          .eq("id", deliveryId)
          .single()

        if (sd) {
          await dbWriteSafe(
            supabaseAdmin
              .from("service_deliveries")
              .update({
                notes: (sd.notes || "") + `\n${new Date().toISOString().split("T")[0]}: Closure form completed. Data saved to Drive. Luca notified.`,
                updated_at: new Date().toISOString(),
              })
              .eq("id", sd.id),
            "service_deliveries.update"
          )
          results.push({ step: "sd_update", status: "ok" })
        }
      } catch (e) {
        results.push({ step: "sd_update", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ---- STEP 7: Log action ----
    try {
      await dbWriteSafe(
        supabaseAdmin.from("action_log").insert({
          action_type: "closure_form_completed",
          table_name: "closure_submissions",
          record_id: submission_id,
          summary: `Closure form completed: ${llcName} (${clientName}). Drive saved, Luca notified.`,
          details: { token, lead_id: leadId, contact_id: contactId, account_id: accountId, results } as unknown as Json,
        }),
        "action_log.insert"
      )
    } catch { /* non-blocking */ }

    // eslint-disable-next-line no-console
    console.log(`[closure-form-completed] ${llcName}: ${results.length} steps. ${results.filter(r => r.status === "ok").length} ok`)

    return NextResponse.json({ ok: true, results })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error("[closure-form-completed] Error:", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
