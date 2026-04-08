/**
 * POST /api/ss4-signed
 *
 * Called by the SS-4 frontend after the client signs.
 * 1. Creates task for Luca
 * 2. Updates service delivery stage_history
 * 3. Uploads signed PDF to Google Drive
 * 4. Merges signed SS-4 + Articles of Organization into IRS package
 * 5. Sends email to support@ with merged PDF attached
 *
 * Body: { ss4_id: string, token: string }
 * No auth required (public endpoint — only triggers internal notifications)
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { autoSaveDocument } from "@/lib/portal/auto-save-document"
import { PDFDocument } from "pdf-lib"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { ss4_id, token } = body as { ss4_id?: string; token?: string }

    if (!ss4_id || !token) {
      return NextResponse.json({ error: "ss4_id and token required" }, { status: 400 })
    }

    // Fetch SS-4 record
    const { data: ss4, error: ss4Err } = await supabaseAdmin
      .from("ss4_applications")
      .select("id, token, company_name, account_id, contact_id, entity_type, responsible_party_name, status, state_of_formation")
      .eq("id", ss4_id)
      .eq("token", token)
      .single()

    if (ss4Err || !ss4) {
      return NextResponse.json({ error: "SS-4 not found" }, { status: 404 })
    }

    if (ss4.status !== "signed") {
      return NextResponse.json({ error: "SS-4 not signed" }, { status: 400 })
    }

    const results: { step: string; status: string; detail?: string }[] = []

    // Track the merged PDF bytes for email attachment
    let mergedPdfBytes: Uint8Array | null = null
    let mergedFileName = `Form SS-4 - ${ss4.company_name} - For IRS.pdf`

    // ─── 1. CREATE TASK FOR LUCA ───
    if (ss4.account_id) {
      try {
        await supabaseAdmin.from("tasks").insert({
          task_title: `Fax SS-4 to IRS: ${ss4.company_name}`,
          description: `The SS-4 for ${ss4.company_name} has been signed. Download from Drive and fax to IRS at (855) 641-6935.`,
          assigned_to: "Luca",
          priority: "High",
          category: "Filing",
          account_id: ss4.account_id,
          status: "To Do",
        })
        results.push({ step: "create_task", status: "ok", detail: "Task created for Luca" })
      } catch (e) {
        results.push({ step: "create_task", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ─── 2. UPDATE SERVICE DELIVERY STAGE HISTORY ───
    if (ss4.account_id) {
      try {
        const { data: sd } = await supabaseAdmin
          .from("service_deliveries")
          .select("id, stage, stage_history")
          .eq("account_id", ss4.account_id)
          .eq("service_type", "Company Formation")
          .eq("status", "active")
          .limit(1)
          .maybeSingle()

        if (sd) {
          const history = Array.isArray(sd.stage_history) ? sd.stage_history : []
          history.push({
            event: "ss4_signed",
            at: new Date().toISOString(),
            note: `SS-4 signed for ${ss4.company_name} — ready to fax to IRS`,
          })

          await supabaseAdmin
            .from("service_deliveries")
            .update({ stage_history: history, updated_at: new Date().toISOString() })
            .eq("id", sd.id)

          results.push({ step: "sd_history", status: "ok", detail: `Updated SD ${sd.id} history` })
        } else {
          results.push({ step: "sd_history", status: "skipped", detail: "No active Company Formation SD" })
        }
      } catch (e) {
        results.push({ step: "sd_history", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ─── 3. AUTO-UPLOAD SIGNED PDF TO DRIVE ───
    if (ss4.account_id) {
      try {
        const { data: acct } = await supabaseAdmin
          .from("accounts")
          .select("drive_folder_id")
          .eq("id", ss4.account_id)
          .single()

        if (acct?.drive_folder_id) {
          const { listFolder, uploadBinaryToDrive } = await import("@/lib/google-drive")
          const folderResult = await listFolder(acct.drive_folder_id) as { files?: { id: string; name: string; mimeType: string }[] }
          const companyFolder = folderResult.files?.find(f =>
            f.name.includes("Company") && f.mimeType === "application/vnd.google-apps.folder"
          )
          const targetFolderId = companyFolder?.id || acct.drive_folder_id

          // Find the signed PDF in Storage
          const { data: files } = await supabaseAdmin.storage
            .from("signed-ss4")
            .list(ss4.token, { limit: 1, sortBy: { column: "created_at", order: "desc" } })

          if (files?.length) {
            const pdfFile = files[0]
            const { data: blob } = await supabaseAdmin.storage
              .from("signed-ss4")
              .download(`${ss4.token}/${pdfFile.name}`)

            if (blob) {
              const arrayBuffer = await blob.arrayBuffer()
              const fileData = Buffer.from(arrayBuffer)
              const fileName = `Form SS-4 - ${ss4.company_name} - Signed.pdf`

              const driveResult = await uploadBinaryToDrive(fileName, fileData, "application/pdf", targetFolderId) as { id: string }

              // Update ss4_applications with Drive file ID
              await supabaseAdmin
                .from("ss4_applications")
                .update({ pdf_signed_drive_id: driveResult.id, updated_at: new Date().toISOString() })
                .eq("id", ss4.id)

              results.push({ step: "drive_upload", status: "ok", detail: `Uploaded to Drive: ${driveResult.id}` })

              // Auto-save to documents table
              await autoSaveDocument({
                accountId: ss4.account_id,
                fileName,
                documentType: "Form SS-4",
                category: 1, // Company
                driveFileId: driveResult.id,
                portalVisible: true,
              })
            } else {
              results.push({ step: "drive_upload", status: "error", detail: "Could not download PDF from Storage" })
            }
          } else {
            results.push({ step: "drive_upload", status: "skipped", detail: "No PDF found in Storage" })
          }
        } else {
          results.push({ step: "drive_upload", status: "skipped", detail: "No drive_folder_id on account" })
        }
      } catch (e) {
        results.push({ step: "drive_upload", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ─── 4. COMBINE SIGNED SS-4 + ARTICLES OF ORGANIZATION (IRS Package) ───
    if (ss4.account_id) {
      try {
        const { data: acct } = await supabaseAdmin
          .from("accounts")
          .select("drive_folder_id")
          .eq("id", ss4.account_id)
          .single()

        if (acct?.drive_folder_id) {
          const { listFolder, downloadFileBinary, uploadBinaryToDrive } = await import("@/lib/google-drive")

          // Find Articles of Organization in Drive (in "1. Company" subfolder)
          const folderResult = await listFolder(acct.drive_folder_id) as { files?: { id: string; name: string; mimeType: string }[] }
          const companyFolder = folderResult.files?.find(f =>
            f.name.includes("Company") && f.mimeType === "application/vnd.google-apps.folder"
          )

          let articlesFileId: string | null = null
          if (companyFolder?.id) {
            const companyFiles = await listFolder(companyFolder.id) as { files?: { id: string; name: string; mimeType: string }[] }
            const articlesFile = companyFiles.files?.find(f =>
              /articles/i.test(f.name) && f.mimeType === "application/pdf"
            )
            articlesFileId = articlesFile?.id || null
          }

          if (articlesFileId) {
            // Download the signed SS-4 from Storage
            const { data: ss4Files } = await supabaseAdmin.storage
              .from("signed-ss4")
              .list(ss4.token, { limit: 1, sortBy: { column: "created_at", order: "desc" } })

            const ss4File = ss4Files?.[0]
            const { data: ss4Blob } = ss4File
              ? await supabaseAdmin.storage.from("signed-ss4").download(`${ss4.token}/${ss4File.name}`)
              : { data: null }

            // Download Articles from Drive
            const { buffer: articlesBuffer } = await downloadFileBinary(articlesFileId)

            if (ss4Blob && articlesBuffer) {
              const ss4Bytes = new Uint8Array(await ss4Blob.arrayBuffer())

              // Merge: signed SS-4 (page 1 only) + Articles into one PDF
              const mergedPdf = await PDFDocument.create()

              const ss4Doc = await PDFDocument.load(ss4Bytes)
              // Only copy page 1 (SS-4 form) — page 2 is info only
              const ss4Pages = await mergedPdf.copyPages(ss4Doc, [0])
              ss4Pages.forEach(p => mergedPdf.addPage(p))

              const articlesDoc = await PDFDocument.load(articlesBuffer)
              const articlesPages = await mergedPdf.copyPages(articlesDoc, articlesDoc.getPageIndices())
              articlesPages.forEach(p => mergedPdf.addPage(p))

              mergedPdfBytes = await mergedPdf.save()

              // Upload combined PDF to Drive
              const targetFolderId = companyFolder?.id || acct.drive_folder_id
              mergedFileName = `Form SS-4 - ${ss4.company_name} - For IRS.pdf`
              const driveResult = await uploadBinaryToDrive(mergedFileName, Buffer.from(mergedPdfBytes), "application/pdf", targetFolderId) as { id: string }

              results.push({ step: "irs_package", status: "ok", detail: `Combined SS-4 + Articles uploaded: ${driveResult.id} (${ss4Pages.length + articlesPages.length} pages)` })
            } else {
              results.push({ step: "irs_package", status: "error", detail: "Could not download SS-4 or Articles for merging" })
            }
          } else {
            results.push({ step: "irs_package", status: "skipped", detail: "Articles of Organization not found in Drive" })
          }
        }
      } catch (e) {
        results.push({ step: "irs_package", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // ─── 5. EMAIL NOTIFICATION WITH ATTACHMENT (sent LAST so we can attach merged PDF) ───
    // If merge didn't produce bytes, fall back to the signed SS-4 alone
    let attachmentBytes = mergedPdfBytes
    let attachmentName = mergedFileName
    if (!attachmentBytes) {
      try {
        const { data: ss4Files } = await supabaseAdmin.storage
          .from("signed-ss4")
          .list(ss4.token, { limit: 1, sortBy: { column: "created_at", order: "desc" } })
        const ss4File = ss4Files?.[0]
        if (ss4File) {
          const { data: blob } = await supabaseAdmin.storage.from("signed-ss4").download(`${ss4.token}/${ss4File.name}`)
          if (blob) {
            attachmentBytes = new Uint8Array(await blob.arrayBuffer())
            attachmentName = `Form SS-4 - ${ss4.company_name} - Signed.pdf`
          }
        }
      } catch { /* continue without attachment */ }
    }

    try {
      const { gmailPost } = await import("@/lib/gmail")

      const subject = `SS-4 Signed — Ready to Fax: ${ss4.company_name}`
      const emailBody = [
        `The SS-4 (EIN Application) for ${ss4.company_name} has been signed and is READY TO FAX to the IRS.`,
        ``,
        `Company: ${ss4.company_name}`,
        `Entity Type: ${ss4.entity_type || "SMLLC"}`,
        `State: ${ss4.state_of_formation}`,
        `Responsible Party: ${ss4.responsible_party_name}`,
        ``,
        `IRS Fax Number: (855) 641-6935`,
        ``,
        attachmentBytes
          ? `The signed SS-4 is attached. Print and fax to the IRS.`
          : `ACTION REQUIRED: Download the signed SS-4 PDF from the client's Drive folder and fax it to the IRS.`,
        ``,
        `Admin Preview: ${APP_BASE_URL}/ss4/${ss4.token}?preview=td`,
      ].join("\n")

      const boundary = `boundary_${Date.now()}`
      const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`

      let rawEmail: string

      if (attachmentBytes) {
        // Email with PDF attachment
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
        const attachmentPart = [
          `--${boundary}`,
          `Content-Type: application/pdf; name="${attachmentName}"`,
          `Content-Disposition: attachment; filename="${attachmentName}"`,
          "Content-Transfer-Encoding: base64",
          "",
          pdfBase64,
          `--${boundary}--`,
        ].join("\r\n")

        rawEmail = [...mimeHeaders, "", textPart, attachmentPart].join("\r\n")
      } else {
        // Plain text email (no attachment available)
        const mimeHeaders = [
          `From: Tony Durante LLC <support@tonydurante.us>`,
          `To: support@tonydurante.us`,
          `Subject: ${encodedSubject}`,
          "MIME-Version: 1.0",
          `Content-Type: text/plain; charset=utf-8`,
          "Content-Transfer-Encoding: base64",
        ]
        rawEmail = [...mimeHeaders, "", Buffer.from(emailBody).toString("base64")].join("\r\n")
      }

      const encodedRaw = Buffer.from(rawEmail).toString("base64url")
      await gmailPost("/messages/send", { raw: encodedRaw })
      results.push({
        step: "email_notification",
        status: "ok",
        detail: attachmentBytes ? `Email sent with ${attachmentName} attached` : "Email sent (no attachment)",
      })
    } catch (e) {
      results.push({ step: "email_notification", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // Log to action_log for CRM Recent Activity + realtime notifications
    try {
      await supabaseAdmin.from("action_log").insert({
        actor: "system",
        action_type: "ss4_signed",
        table_name: "ss4_applications",
        record_id: ss4.id,
        account_id: ss4.account_id || null,
        contact_id: ss4.contact_id || null,
        summary: `SS-4 signed: ${ss4.company_name} — ready to fax to IRS`,
        details: { token, company_name: ss4.company_name, entity_type: ss4.entity_type },
      })
    } catch { /* non-blocking */ }

    return NextResponse.json({ ok: true, results })
  } catch (err) {
    console.error("[ss4-signed]", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
