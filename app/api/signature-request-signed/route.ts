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

    // service_delivery_id was added by migration but the generated DB types
    // aren't regenerated — select it via an untyped surface.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: sigReq, error: sigErr } = await (supabaseAdmin as any)
      .from("signature_requests")
      .select("id, token, document_name, account_id, contact_id, signed_pdf_path, service_delivery_id")
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

            // If this request is bound to a flow, stamp the signed document so
            // it shows in that flow's Documents viewer.
            if (sigReq.service_delivery_id) {
              // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
              await supabaseAdmin
                .from("documents")
                .update({ service_delivery_id: sigReq.service_delivery_id, flow_stage: "Signed" } as never)
                .eq("drive_file_id", driveFileId)
            }

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

    // 1b. Guaranteed flow-document registration (Drive-independent).
    //
    // The Drive upload above can fail — sandbox has no working Drive, an account
    // may lack a drive_folder_id, or the API can hiccup — and its error is
    // swallowed, leaving the signed PDF with NO `documents` row, so it never
    // appears in the flow Workspace document viewer (the SD still advances to
    // "Signed" via step 4, which is why this gap was invisible).
    //
    // For a flow-bound signature, register the signed PDF as a `documents` row
    // served from storage (long-lived signed URL on the signed-documents bucket),
    // stamped with the SD + flow_stage="Signed". Idempotent: skips if the Drive
    // path already created the Signed doc for this SD, so production (where Drive
    // works) does not get a duplicate.
    if (sigReq.signed_pdf_path && sigReq.service_delivery_id) {
      try {
        const fileName = `${sigReq.document_name} - Signed.pdf`
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: existingDoc } = await (supabaseAdmin as any)
          .from("documents")
          .select("id")
          .eq("service_delivery_id", sigReq.service_delivery_id)
          .eq("flow_stage", "Signed")
          .eq("file_name", fileName)
          .maybeSingle()

        if (existingDoc) {
          results.push("flow_doc: exists")
        } else {
          const { data: signedUrl } = await supabaseAdmin.storage
            .from("signed-documents")
            .createSignedUrl(sigReq.signed_pdf_path, 60 * 60 * 24 * 365) // 1 year

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (supabaseAdmin as any).from("documents").insert({
            account_id: sigReq.account_id,
            contact_id: sigReq.contact_id,
            file_name: fileName,
            document_type_name: sigReq.document_name,
            category: 5, // Correspondence — matches the Drive-path autoSaveDocument
            drive_file_id: `storage:signed-documents/${sigReq.signed_pdf_path}`,
            drive_link: signedUrl?.signedUrl ?? null,
            service_delivery_id: sigReq.service_delivery_id,
            flow_stage: "Signed",
            portal_visible: true,
            notify_client: false,
          })
          results.push("flow_doc: created")
        }
      } catch (err) {
        results.push(`flow_doc: error - ${err instanceof Error ? err.message : "unknown"}`)
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

    // 4. Flow auto-advance: a tax-return signature request advances its SD from
    //    "Sent for Signature" → "Signed". Guarded to that stage for idempotency
    //    (a re-fired webhook on an already-"Signed" SD is a no-op).
    if (sigReq.service_delivery_id) {
      try {
        const { data: sd } = await supabaseAdmin
          .from("service_deliveries")
          .select("stage")
          .eq("id", sigReq.service_delivery_id)
          .single()
        if (sd?.stage === "Sent for Signature") {
          const { advanceServiceDelivery } = await import("@/lib/service-delivery")
          await advanceServiceDelivery({
            delivery_id: sigReq.service_delivery_id,
            target_stage: "Signed",
            actor: "signature-webhook",
            notes: `Client signed: ${sigReq.document_name}`,
          })
          results.push("flow_advance: ok")
        } else {
          results.push(`flow_advance: skipped (stage=${sd?.stage ?? "unknown"})`)
        }
      } catch (err) {
        results.push(`flow_advance: error - ${err instanceof Error ? err.message : "unknown"}`)
      }
    }

    return NextResponse.json({ ok: true, results })
  } catch (err) {
    console.error("[signature-request-signed]", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
