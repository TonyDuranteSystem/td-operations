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

    // --- 1. EMAIL NOTIFICATION TO SUPPORT ---
    try {
      const { gmailPost } = await import("@/lib/gmail")

      const subject = `ITIN Form Completed: ${displayName}`
      const emailBody = [
        `The ITIN data collection form for ${displayName} has been submitted by the client.`,
        ``,
        `Token: ${sub.token}`,
        `Language: ${sub.language}`,
        companyName ? `Company: ${companyName}` : null,
        ``,
        `Next steps:`,
        `- Review submitted data: itin_form_review(token="${sub.token}")`,
        `- If data complete, apply changes and prepare W-7 + 1040-NR`,
        ``,
        `Admin Preview: ${APP_BASE_URL}/itin-form/${sub.token}?preview=td`,
      ].filter(Boolean).join("\n")

      const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
      const mimeHeaders = [
        `From: Tony Durante LLC <support@tonydurante.us>`,
        `To: support@tonydurante.us`,
        `Subject: ${encodedSubject}`,
        "MIME-Version: 1.0",
        `Content-Type: text/plain; charset=utf-8`,
        "Content-Transfer-Encoding: base64",
      ]
      const rawEmail = [...mimeHeaders, "", Buffer.from(emailBody).toString("base64")].join("\r\n")
      const encodedRaw = Buffer.from(rawEmail).toString("base64url")

      await gmailPost("/messages/send", { raw: encodedRaw })
      results.push({ step: "email_notification", status: "ok", detail: `Notified support@ about ${displayName}` })
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

    // --- 4. SAVE FORM DATA + UPLOADS TO DRIVE ---
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
