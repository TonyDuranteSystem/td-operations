/**
 * POST /api/tax-form-completed
 *
 * Called by the tax form frontend after the client submits.
 * 1. Sends email notification to support@
 * 2. Updates service delivery stage_history
 * 3. Creates review task for Antonio
 *
 * Body: { submission_id: string, token: string }
 * No auth required (public endpoint — only triggers internal notifications)
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
      .from("tax_return_submissions")
      .select("id, token, account_id, contact_id, tax_year, entity_type, status")
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

    // Get company name
    let companyName = token
    if (sub.account_id) {
      const { data: acc } = await supabaseAdmin
        .from("accounts")
        .select("company_name")
        .eq("id", sub.account_id)
        .single()
      if (acc) companyName = acc.company_name
    }

    // ─── 1. EMAIL NOTIFICATION TO SUPPORT ───
    try {
      const { gmailPost } = await import("@/lib/gmail")

      const subject = `Tax Form Completed: ${companyName} (${sub.tax_year})`
      const emailBody = [
        `The tax data collection form for ${companyName} has been submitted by the client.`,
        ``,
        `Tax Year: ${sub.tax_year}`,
        `Entity Type: ${sub.entity_type}`,
        `Token: ${sub.token}`,
        ``,
        `Next steps:`,
        `- Review submitted data: tax_form_review(token="${sub.token}")`,
        `- If data complete, apply changes and advance pipeline`,
        ``,
        `Admin Preview: ${APP_BASE_URL}/tax-form/${sub.token}?preview=td`,
      ].join("\n")

      const mimeHeaders = [
        `From: Tony Durante LLC <support@tonydurante.us>`,
        `To: support@tonydurante.us`,
        `Subject: ${subject}`,
        "MIME-Version: 1.0",
        `Content-Type: text/plain; charset=utf-8`,
        "Content-Transfer-Encoding: base64",
      ]
      const rawEmail = [...mimeHeaders, "", Buffer.from(emailBody).toString("base64")].join("\r\n")
      const encodedRaw = Buffer.from(rawEmail).toString("base64url")

      await gmailPost("/messages/send", { raw: encodedRaw })
      results.push({ step: "email_notification", status: "ok", detail: `Notified support@ about ${companyName}` })
    } catch (e) {
      results.push({ step: "email_notification", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // ─── 2. UPDATE SERVICE DELIVERY HISTORY ───
    if (sub.account_id) {
      try {
        const { data: sd } = await supabaseAdmin
          .from("service_deliveries")
          .select("id, stage, stage_order, stage_history, service_type")
          .eq("account_id", sub.account_id)
          .eq("service_type", "Tax Return Filing")
          .eq("status", "active")
          .limit(1)
          .maybeSingle()

        if (sd) {
          const history = Array.isArray(sd.stage_history) ? sd.stage_history : []
          history.push({
            event: "tax_form_submitted",
            at: new Date().toISOString(),
            note: `Tax form submitted by client for ${companyName} (${sub.tax_year})`,
          })

          await supabaseAdmin
            .from("service_deliveries")
            .update({ stage_history: history })
            .eq("id", sd.id)

          results.push({ step: "sd_history", status: "ok", detail: `Updated SD ${sd.id} history (stage: ${sd.stage})` })
        } else {
          results.push({ step: "sd_history", status: "skipped", detail: "No active Tax Return Filing SD found" })
        }
      } catch (e) {
        results.push({ step: "sd_history", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }

      // ─── 3. CREATE REVIEW TASK FOR ANTONIO ───
      try {
        const taskTitle = `Review tax form data — ${companyName} (${sub.tax_year})`

        const { data: existingTask } = await supabaseAdmin
          .from("tasks")
          .select("id")
          .eq("task_title", taskTitle)
          .eq("account_id", sub.account_id)
          .maybeSingle()

        if (!existingTask) {
          await supabaseAdmin.from("tasks").insert({
            task_title: taskTitle,
            description: [
              `Client ${companyName} has submitted tax data for ${sub.tax_year}.`,
              ``,
              `Entity type: ${sub.entity_type}`,
              `Review: tax_form_review(token="${sub.token}")`,
              `Action: Review data completeness, then apply_changes=true to update CRM.`,
            ].join("\n"),
            assigned_to: "Antonio",
            priority: "High",
            category: "Tax",
            status: "To Do",
            account_id: sub.account_id,
            created_by: "System",
          })
          results.push({ step: "review_task", status: "ok", detail: taskTitle })
        } else {
          results.push({ step: "review_task", status: "skipped", detail: "Already exists" })
        }
      } catch (e) {
        results.push({ step: "review_task", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ─── 4. GENERATE PDF & UPLOAD TO DRIVE ───
    if (sub.account_id) {
      try {
        // Get full submission data for PDF
        const { data: fullSub } = await supabaseAdmin
          .from("tax_return_submissions")
          .select("submitted_data, upload_paths, completed_at")
          .eq("id", submission_id)
          .single()

        // Get account Drive folder
        const { data: acc } = await supabaseAdmin
          .from("accounts")
          .select("company_name, drive_folder_id, ein_number, state_of_formation")
          .eq("id", sub.account_id)
          .single()

        if (fullSub?.submitted_data && acc?.drive_folder_id) {
          const { generateTaxFormPDF } = await import("@/lib/pdf/tax-form-pdf")
          const { listFolder, createFolder, uploadBinaryToDrive } = await import("@/lib/google-drive")

          const pdfBytes = await generateTaxFormPDF({
            companyName: acc.company_name || companyName,
            ein: acc.ein_number || fullSub.submitted_data.ein_number as string || "N/A",
            state: acc.state_of_formation || fullSub.submitted_data.state_of_incorporation as string || "N/A",
            incorporationDate: fullSub.submitted_data.date_of_incorporation as string || "N/A",
            taxYear: sub.tax_year || "N/A",
            submittedAt: fullSub.completed_at || new Date().toISOString(),
            submittedData: fullSub.submitted_data as Record<string, unknown>,
            uploadPaths: (fullSub.upload_paths as string[]) || [],
          })

          // Find or create "5. Tax Returns" subfolder
          const folderContents = await listFolder(acc.drive_folder_id)
          const files = folderContents?.files || []
          const taxFolder = files.find(
            (f: { name: string; mimeType: string }) =>
              f.name === "5. Tax Returns" && f.mimeType === "application/vnd.google-apps.folder"
          )
          let taxFolderId = taxFolder?.id

          if (!taxFolderId) {
            const newFolder = await createFolder(acc.drive_folder_id, "5. Tax Returns")
            taxFolderId = newFolder.id
          }

          if (taxFolderId) {
            const pdfName = `Tax Data Collection - ${acc.company_name} - ${sub.tax_year}.pdf`
            const uploadResult = await uploadBinaryToDrive(
              pdfName,
              Buffer.from(pdfBytes),
              "application/pdf",
              taxFolderId,
            )

            results.push({
              step: "pdf_drive_upload",
              status: "ok",
              detail: `Uploaded "${pdfName}" to Drive (${uploadResult.id})`,
            })
          } else {
            results.push({
              step: "pdf_drive_upload",
              status: "error",
              detail: "Could not find or create '5. Tax Returns' folder",
            })
          }
        } else {
          results.push({
            step: "pdf_drive_upload",
            status: "skipped",
            detail: `submitted_data=${!!fullSub?.submitted_data}, drive_folder_id=${acc?.drive_folder_id || 'null'}, account_id=${sub.account_id}`,
          })
        }
      } catch (e) {
        results.push({
          step: "pdf_drive_upload",
          status: "error",
          detail: e instanceof Error ? e.message : String(e),
        })
      }
    }

    return NextResponse.json({ ok: true, results })
  } catch (err) {
    console.error("[tax-form-completed]", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
