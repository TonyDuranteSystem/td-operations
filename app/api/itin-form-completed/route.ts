/**
 * POST /api/itin-form-completed
 *
 * Called by the ITIN form frontend after the client submits.
 * 1. Sends email notification to support@
 * 2. Updates service delivery stage_history
 * 3. Creates review task for Antonio
 *
 * Body: { submission_id: string, token: string }
 * No auth required (public endpoint - only triggers internal notifications)
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"

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

    // Get client name from lead or contact
    let clientName = token
    if (sub.lead_id) {
      const { data: lead } = await supabaseAdmin
        .from("leads")
        .select("full_name")
        .eq("id", sub.lead_id)
        .single()
      if (lead) clientName = lead.full_name
    } else if (sub.contact_id) {
      const { data: contact } = await supabaseAdmin
        .from("contacts")
        .select("full_name")
        .eq("id", sub.contact_id)
        .single()
      if (contact) clientName = contact.full_name
    }

    // Get company name if linked to account
    let companyName: string | null = null
    if (sub.account_id) {
      const { data: acc } = await supabaseAdmin
        .from("accounts")
        .select("company_name")
        .eq("id", sub.account_id)
        .single()
      if (acc) companyName = acc.company_name
    }

    const displayName = companyName ? `${clientName} (${companyName})` : clientName

    // --- 1. DETAILED EMAIL TO LUCA + ANTONIO ---
    try {
      const { gmailPost } = await import("@/lib/gmail")

      // Get full submission data for detailed email
      const { data: fullSubEmail } = await supabaseAdmin
        .from("itin_submissions")
        .select("submitted_data")
        .eq("id", submission_id)
        .single()

      const sd = (fullSubEmail?.submitted_data || {}) as Record<string, unknown>

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
</table>

<h3>Foreign Address</h3>
<p>${[sd.foreign_street, sd.foreign_city, sd.foreign_state, sd.foreign_zip, sd.foreign_country].filter(Boolean).join(", ") || "N/A"}</p>

<h3>Visa / US Info</h3>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:4px 8px;font-weight:bold">Visa type:</td><td style="padding:4px 8px">${sd.us_visa_type || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Passport #:</td><td style="padding:4px 8px">${sd.passport_number || "N/A"}</td></tr>
<tr><td style="padding:4px 8px;font-weight:bold">Previous ITIN:</td><td style="padding:4px 8px">${sd.has_previous_itin ? sd.previous_itin || "Yes" : "No"}</td></tr>
</table>

<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0"/>

<h3>Next Steps (per SOP ITIN v3.0)</h3>
<ol>
<li>Review data completeness: <code>itin_form_review(token="${sub.token}")</code></li>
<li>If complete, apply changes: <code>itin_form_review(token="${sub.token}", apply_changes=true)</code></li>
<li>Generate W-7 + 1040-NR: <code>itin_prepare_documents(token="${sub.token}")</code></li>
<li>Antonio reviews generated PDFs</li>
<li>Send to client for signature: <code>itin_prepare_documents(token="${sub.token}", send_email=true)</code></li>
</ol>

<p style="font-size:12px;color:#6b7280">Token: ${sub.token} | Admin: ${APP_BASE_URL}/itin-form/${sub.token}?preview=td</p>
</div>`

      const raw = Buffer.from(
        `From: Tony Durante CRM <support@tonydurante.us>\r\n` +
        `To: support@tonydurante.us\r\n` +
        `Cc: antonio.durante@tonydurante.us\r\n` +
        `Subject: [TASK] ITIN Form Completed - ${displayName}\r\n` +
        `MIME-Version: 1.0\r\n` +
        `Content-Type: text/html; charset=utf-8\r\n\r\n` +
        emailBody
      ).toString("base64url")

      await gmailPost("/messages/send", { raw })
      results.push({ step: "email_notification", status: "ok", detail: `Detailed email sent to support@ + antonio@` })
    } catch (e) {
      results.push({ step: "email_notification", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // --- 2. UPDATE SERVICE DELIVERY HISTORY ---
    const sdAccountId = sub.account_id
    const sdContactId = sub.contact_id
    if (sdAccountId || sdContactId) {
      try {
        // ITIN can be linked to account (bundled) or contact (individual)
        let sdQuery = supabaseAdmin
          .from("service_deliveries")
          .select("id, stage, stage_order, stage_history, service_type")
          .eq("service_type", "ITIN")
          .eq("status", "active")
          .limit(1)

        if (sdAccountId) {
          sdQuery = sdQuery.eq("account_id", sdAccountId)
        } else if (sdContactId) {
          sdQuery = sdQuery.eq("contact_id", sdContactId)
        }

        const { data: sd } = await sdQuery.maybeSingle()

        if (sd) {
          const history = Array.isArray(sd.stage_history) ? sd.stage_history : []
          history.push({
            event: "itin_form_submitted",
            at: new Date().toISOString(),
            note: `ITIN form submitted by client ${displayName}`,
          })

          await supabaseAdmin
            .from("service_deliveries")
            .update({ stage_history: history })
            .eq("id", sd.id)

          results.push({ step: "sd_history", status: "ok", detail: `Updated SD ${sd.id} history (stage: ${sd.stage})` })
        } else {
          results.push({ step: "sd_history", status: "skipped", detail: "No active ITIN SD found" })
        }
      } catch (e) {
        results.push({ step: "sd_history", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // --- 3. CREATE REVIEW TASK ---
    try {
      const taskTitle = `Review ITIN form data - ${displayName}`

      const { data: existingTask } = await supabaseAdmin
        .from("tasks")
        .select("id")
        .eq("task_title", taskTitle)
        .maybeSingle()

      if (!existingTask) {
        await supabaseAdmin.from("tasks").insert({
          task_title: taskTitle,
          description: [
            `Client ${displayName} has submitted ITIN application data.`,
            ``,
            `Review: itin_form_review(token="${sub.token}")`,
            `Action: Review data completeness, then apply_changes=true to update CRM and prepare W-7 + 1040-NR.`,
          ].join("\n"),
          assigned_to: "Antonio",
          priority: "High",
          category: "KYC",
          status: "To Do",
          account_id: sub.account_id || undefined,
          created_by: "System",
        })
        results.push({ step: "review_task", status: "ok", detail: taskTitle })
      } else {
        results.push({ step: "review_task", status: "skipped", detail: "Already exists" })
      }
    } catch (e) {
      results.push({ step: "review_task", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // --- 4. APPLY FORM DATA TO CRM (update contact) ---
    const contactId = sub.contact_id
    if (contactId) {
      try {
        const { data: fullSubCrm } = await supabaseAdmin
          .from("itin_submissions")
          .select("submitted_data")
          .eq("id", submission_id)
          .single()

        const sd = fullSubCrm?.submitted_data as Record<string, unknown> | null
        if (sd) {
          const updates: Record<string, unknown> = {}
          if (sd.dob) updates.date_of_birth = sd.dob
          if (sd.citizenship) updates.citizenship = sd.citizenship
          if (sd.country_of_birth) updates.notes = `Country of birth: ${sd.country_of_birth}, City: ${sd.city_of_birth || "N/A"}`

          // Build foreign address
          const addrParts = [sd.foreign_street, sd.foreign_city, sd.foreign_state, sd.foreign_zip, sd.foreign_country].filter(Boolean)
          if (addrParts.length > 0) updates.residency = addrParts.join(", ")

          if (Object.keys(updates).length > 0) {
            updates.updated_at = new Date().toISOString()
            await supabaseAdmin.from("contacts").update(updates).eq("id", contactId)
            results.push({ step: "crm_update", status: "ok", detail: `Contact updated: ${Object.keys(updates).join(", ")}` })
          }
        }
      } catch (e) {
        results.push({ step: "crm_update", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // --- 4B. ADVANCE SD to Stage 2 (Form Submitted) ---
    if (sub.account_id || sub.contact_id) {
      try {
        let sdQuery = supabaseAdmin
          .from("service_deliveries")
          .select("id, current_stage")
          .eq("service_type", "ITIN")
          .eq("status", "active")
          .limit(1)

        if (sub.account_id) sdQuery = sdQuery.eq("account_id", sub.account_id)
        else if (sub.contact_id) sdQuery = sdQuery.eq("contact_id", sub.contact_id)

        const { data: sd } = await sdQuery.maybeSingle()
        if (sd && sd.current_stage === "Data Collection") {
          await supabaseAdmin
            .from("service_deliveries")
            .update({ current_stage: "Form Submitted", updated_at: new Date().toISOString() })
            .eq("id", sd.id)
          results.push({ step: "sd_advance", status: "ok", detail: `SD ${sd.id} advanced to Form Submitted` })
        }
      } catch (e) {
        results.push({ step: "sd_advance", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // --- 5. SAVE FORM DATA + UPLOADS TO DRIVE ---
    const accountId = sub.account_id
    if (accountId) {
      try {
        const { data: acc } = await supabaseAdmin
          .from("accounts")
          .select("drive_folder_id")
          .eq("id", accountId)
          .single()

        if (acc?.drive_folder_id) {
          // Get full submission data
          const { data: fullSub } = await supabaseAdmin
            .from("itin_submissions")
            .select("submitted_data, upload_paths, completed_at")
            .eq("id", submission_id)
            .single()

          if (fullSub?.submitted_data) {
            const { saveFormToDrive } = await import("@/lib/form-to-drive")
            const driveResult = await saveFormToDrive(
              "itin",
              fullSub.submitted_data as Record<string, unknown>,
              (fullSub.upload_paths as string[]) || [],
              acc.drive_folder_id,
              { token: sub.token, submittedAt: fullSub.completed_at || new Date().toISOString(), companyName: displayName }
            )
            if (driveResult.summaryFileId) {
              results.push({ step: "drive_save", status: "ok", detail: `Data summary: ${driveResult.summaryFileId}, ${driveResult.copied.length} files copied` })
            } else {
              results.push({ step: "drive_save", status: "error", detail: driveResult.errors.join(", ") })
            }
          }
        } else {
          results.push({ step: "drive_save", status: "skipped", detail: "No drive_folder_id on account" })
        }
      } catch (e) {
        results.push({ step: "drive_save", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    return NextResponse.json({ ok: true, results })
  } catch (err) {
    console.error("[itin-form-completed]", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
