/**
 * POST /api/signature-request-signed
 *
 * Called by the signing page after the client signs a generic document.
 * 1. Uploads signed PDF to Google Drive (client's folder)
 * 2. Registers in documents table (portal_visible = true)
 * 3. Sends email notification to support@
 * 4. Creates a task for Luca
 *
 * Body: { signature_request_id: string, token: string }
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { autoSaveDocument } from "@/lib/portal/auto-save-document"
import { updateDocument } from "@/lib/operations/document"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { signature_request_id, token } = body as { signature_request_id?: string; token?: string }

    if (!signature_request_id || !token) {
      return NextResponse.json({ error: "signature_request_id and token required" }, { status: 400 })
    }

    const { data: sigReq, error: sigErr } = await supabaseAdmin
      .from("signature_requests")
      .select("id, token, document_name, account_id, contact_id, signed_pdf_path")
      .eq("id", signature_request_id)
      .eq("token", token)
      .single()

    if (sigErr || !sigReq) {
      return NextResponse.json({ error: "Signature request not found" }, { status: 404 })
    }

    // Get account for Drive folder and company name
    const { data: account } = await supabaseAdmin
      .from("accounts")
      .select("company_name, drive_folder_id")
      .eq("id", sigReq.account_id)
      .single()

    const { data: contact } = await supabaseAdmin
      .from("contacts")
      .select("full_name, email")
      .eq("id", sigReq.contact_id)
      .single()

    const results: string[] = []

    // 1. Upload signed PDF to Google Drive + register in documents table
    if (sigReq.signed_pdf_path && account?.drive_folder_id) {
      try {
        const { data: pdfData } = await supabaseAdmin.storage
          .from("signed-documents")
          .download(sigReq.signed_pdf_path)

        if (pdfData) {
          const buffer = Buffer.from(await pdfData.arrayBuffer())
          const fileName = `${sigReq.document_name} - Signed.pdf`

          // Upload to Google Drive
          const { uploadBinaryToDrive, listFolder } = await import("@/lib/google-drive")

          // Find 5. Correspondence subfolder or use root
          let targetFolderId = account.drive_folder_id
          try {
            const folderContents = await listFolder(account.drive_folder_id)
            const corrFolder = folderContents.find((f: { name: string; id: string }) => f.name.startsWith("5"))
            if (corrFolder) targetFolderId = corrFolder.id
          } catch { /* use root folder */ }

          const driveResult = await uploadBinaryToDrive(fileName, buffer, "application/pdf", targetFolderId)
          const driveFileId = (driveResult as { id?: string })?.id

          if (driveFileId) {
            // Register in documents table
            await autoSaveDocument({
              accountId: sigReq.account_id,
              fileName,
              documentType: sigReq.document_name,
              category: 5, // Correspondence
              driveFileId,
            })

            await supabaseAdmin
              .from("signature_requests")
              .update({ signed_pdf_drive_id: driveFileId })
              .eq("id", sigReq.id)

            // Make visible in portal
            await updateDocument({
              drive_file_id: driveFileId,
              account_id: sigReq.account_id,
              patch: { portal_visible: true },
              actor: "system:signature-webhook",
              summary: `Signed document made visible in portal: ${sigReq.document_name}`,
              details: { signature_request_id: sigReq.id, document_name: sigReq.document_name },
            })

            results.push("drive_upload: ok")
          }
        }
      } catch (err) {
        results.push(`drive_upload: error - ${err instanceof Error ? err.message : "unknown"}`)
      }
    }

    // 2. Send email notification to support@
    try {
      const { gmailPost } = await import("@/lib/gmail")
      const subject = `Document Signed: ${sigReq.document_name} — ${account?.company_name || "Unknown"}`
      const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`
      const body = [
        `${contact?.full_name || "Client"} has signed: ${sigReq.document_name}`,
        `Company: ${account?.company_name || "Unknown"}`,
        `Signed at: ${new Date().toISOString()}`,
        ``,
        `The signed document has been uploaded to the client's Drive folder.`,
      ].join("\r\n")
      const rawEmail = [
        `From: support@tonydurante.us`,
        `To: support@tonydurante.us`,
        `Subject: ${encodedSubject}`,
        `Content-Type: text/plain; charset=UTF-8`,
        ``,
        body,
      ].join("\r\n")
      const encodedRaw = Buffer.from(rawEmail).toString("base64url")
      await gmailPost("/messages/send", { raw: encodedRaw })
      results.push("notification_email: ok")
    } catch (err) {
      results.push(`notification_email: error - ${err instanceof Error ? err.message : "unknown"}`)
    }

    // 3. Create task
    try {
      // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
      await supabaseAdmin.from("tasks").insert({
        task_title: `Document signed: ${sigReq.document_name} — ${account?.company_name || "Unknown"}`,
        assigned_to: "Luca",
        status: "To Do",
        priority: "Normal",
        category: "Document",
        description: `${contact?.full_name} signed "${sigReq.document_name}". Review and process as needed.`,
        account_id: sigReq.account_id,
      })
      results.push("task: ok")
    } catch (err) {
      results.push(`task: error - ${err instanceof Error ? err.message : "unknown"}`)
    }

    return NextResponse.json({ ok: true, results })
  } catch (err) {
    console.error("[signature-request-signed]", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
