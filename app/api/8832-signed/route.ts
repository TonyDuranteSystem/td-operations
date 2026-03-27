/**
 * POST /api/8832-signed
 *
 * Called after the client signs the Form 8832.
 * 1. Creates task for Luca to mail the form to IRS
 * 2. Uploads signed PDF to Google Drive
 * 3. Sends email notification with PDF attached
 *
 * Body: { form_id: string, token: string }
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { autoSaveDocument } from "@/lib/portal/auto-save-document"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { form_id, token } = body as { form_id?: string; token?: string }

    if (!form_id || !token) {
      return NextResponse.json({ error: "form_id and token required" }, { status: 400 })
    }

    const { data: form, error: formErr } = await supabaseAdmin
      .from("form_8832_applications")
      .select("id, token, company_name, account_id, contact_id, entity_type, owner_name, ein, status")
      .eq("id", form_id)
      .eq("token", token)
      .single()

    if (formErr || !form) {
      return NextResponse.json({ error: "Form 8832 not found" }, { status: 404 })
    }

    if (form.status !== "signed") {
      return NextResponse.json({ error: "Form 8832 not signed" }, { status: 400 })
    }

    const results: { step: string; status: string; detail?: string }[] = []

    // ─── 1. CREATE TASK FOR LUCA ───
    if (form.account_id) {
      try {
        await supabaseAdmin.from("tasks").insert({
          task_title: `Mail Form 8832 to IRS: ${form.company_name}`,
          description: `The Form 8832 (C-Corp Election) for ${form.company_name} has been signed. Download from Drive and mail to IRS.\n\nMailing address (FL-based):\nDepartment of the Treasury\nInternal Revenue Service\nOgden, UT 84201\n\nAlso attach a copy to the entity's federal tax return.`,
          assigned_to: "Luca",
          priority: "High",
          category: "Filing",
          account_id: form.account_id,
          status: "To Do",
        })
        results.push({ step: "create_task", status: "ok", detail: "Task created for Luca" })
      } catch (e) {
        results.push({ step: "create_task", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ─── 2. UPLOAD SIGNED PDF TO DRIVE ───
    let attachmentBytes: Uint8Array | null = null
    let attachmentName = `Form 8832 - ${form.company_name} - Signed.pdf`

    if (form.account_id) {
      try {
        const { data: acct } = await supabaseAdmin
          .from("accounts")
          .select("drive_folder_id")
          .eq("id", form.account_id)
          .single()

        if (acct?.drive_folder_id) {
          const { listFolder, uploadBinaryToDrive } = await import("@/lib/google-drive")
          const folderResult = await listFolder(acct.drive_folder_id) as { files?: { id: string; name: string; mimeType: string }[] }
          const companyFolder = folderResult.files?.find(f =>
            f.name.includes("Company") && f.mimeType === "application/vnd.google-apps.folder"
          )
          const targetFolderId = companyFolder?.id || acct.drive_folder_id

          // Download signed PDF from Storage
          const { data: files } = await supabaseAdmin.storage
            .from("signed-8832")
            .list(form.token, { limit: 1, sortBy: { column: "created_at", order: "desc" } })

          if (files?.length) {
            const pdfFile = files[0]
            const { data: blob } = await supabaseAdmin.storage
              .from("signed-8832")
              .download(`${form.token}/${pdfFile.name}`)

            if (blob) {
              const arrayBuffer = await blob.arrayBuffer()
              attachmentBytes = new Uint8Array(arrayBuffer)
              const fileData = Buffer.from(arrayBuffer)

              const driveResult = await uploadBinaryToDrive(attachmentName, fileData, "application/pdf", targetFolderId) as { id: string }

              await supabaseAdmin
                .from("form_8832_applications")
                .update({ pdf_signed_drive_id: driveResult.id, updated_at: new Date().toISOString() })
                .eq("id", form.id)

              results.push({ step: "drive_upload", status: "ok", detail: `Uploaded: ${driveResult.id}` })

              await autoSaveDocument({
                accountId: form.account_id,
                fileName: attachmentName,
                documentType: "Form 8832",
                category: 1,
                driveFileId: driveResult.id,
              })
            }
          }
        }
      } catch (e) {
        results.push({ step: "drive_upload", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ─── 3. EMAIL NOTIFICATION ───
    // If we couldn't get attachment from Drive upload, try Storage directly
    if (!attachmentBytes) {
      try {
        const { data: files } = await supabaseAdmin.storage
          .from("signed-8832")
          .list(form.token, { limit: 1, sortBy: { column: "created_at", order: "desc" } })
        if (files?.[0]) {
          const { data: blob } = await supabaseAdmin.storage.from("signed-8832").download(`${form.token}/${files[0].name}`)
          if (blob) attachmentBytes = new Uint8Array(await blob.arrayBuffer())
        }
      } catch { /* continue without attachment */ }
    }

    try {
      const { gmailPost } = await import("@/lib/gmail")

      const subject = `Form 8832 Signed — C-Corp Election: ${form.company_name}`
      const emailBody = [
        `The Form 8832 (Entity Classification Election) for ${form.company_name} has been signed.`,
        ``,
        `Company: ${form.company_name}`,
        `EIN: ${form.ein}`,
        `Entity Type: ${form.entity_type}`,
        `Owner: ${form.owner_name}`,
        ``,
        `This form must be MAILED to the IRS:`,
        `Department of the Treasury`,
        `Internal Revenue Service`,
        `Ogden, UT 84201`,
        ``,
        attachmentBytes
          ? `The signed Form 8832 is attached. Print and mail to the IRS.`
          : `ACTION REQUIRED: Download the signed Form 8832 from the client's Drive folder.`,
        ``,
        `Admin Preview: ${APP_BASE_URL}/8832/${form.token}?preview=td`,
      ].join("\n")

      const boundary = `boundary_${Date.now()}`
      const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`

      let rawEmail: string
      if (attachmentBytes) {
        const mimeHeaders = [
          `From: Tony Durante LLC <support@tonydurante.us>`,
          `To: support@tonydurante.us`,
          `Subject: ${encodedSubject}`,
          "MIME-Version: 1.0",
          `Content-Type: multipart/mixed; boundary="${boundary}"`,
        ]
        const textPart = [
          `--${boundary}`,
          "Content-Type: text/plain; charset=utf-8",
          "Content-Transfer-Encoding: base64",
          "",
          Buffer.from(emailBody).toString("base64"),
        ].join("\r\n")
        const pdfBase64 = Buffer.from(attachmentBytes).toString("base64")
        const attachPart = [
          `--${boundary}`,
          `Content-Type: application/pdf; name="${attachmentName}"`,
          `Content-Disposition: attachment; filename="${attachmentName}"`,
          "Content-Transfer-Encoding: base64",
          "",
          pdfBase64,
          `--${boundary}--`,
        ].join("\r\n")
        rawEmail = [...mimeHeaders, "", textPart, attachPart].join("\r\n")
      } else {
        rawEmail = [
          `From: Tony Durante LLC <support@tonydurante.us>`,
          `To: support@tonydurante.us`,
          `Subject: ${encodedSubject}`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          "Content-Transfer-Encoding: base64",
          "",
          Buffer.from(emailBody).toString("base64"),
        ].join("\r\n")
      }

      const encodedRaw = Buffer.from(rawEmail).toString("base64url")
      await gmailPost("/messages/send", { raw: encodedRaw })
      results.push({ step: "email_notification", status: "ok" })
    } catch (e) {
      results.push({ step: "email_notification", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    return NextResponse.json({ ok: true, results })
  } catch (err) {
    console.error("[8832-signed]", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
