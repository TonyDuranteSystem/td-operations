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

    // 0. Where do this company's files live? (Drive cutover, dev job ad09ea91.) A switched company has its signed
    //    document saved in the new storage (listed in its documents, stamped with the flow) — never Drive, and never
    //    the storage-served fallback below. A company still on Drive carries on exactly as before.
    let switched = false
    let stateKnown = false
    if (sigReq.signed_pdf_path && sigReq.account_id) {
      try {
        const { companyDocState } = await import("@/lib/crm-store/switched-drive-guard")
        switched = (await companyDocState(sigReq.account_id)) !== "drive"
        stateKnown = true
        if (switched) {
          const { data: pdfData } = await supabaseAdmin.storage.from("signed-documents").download(sigReq.signed_pdf_path)
          if (!pdfData) throw new Error("signed PDF not found in Storage")
          const { saveSignedPdfForAccount } = await import("@/lib/crm-store/save-for-account")
          const routed = await saveSignedPdfForAccount({
            accountId: sigReq.account_id, fileName: `${sigReq.document_name} - Signed.pdf`, bytes: Buffer.from(await pdfData.arrayBuffer()),
            label: sigReq.document_name, category: 5, callerKey: `signature-signed:${sigReq.id}`,
            contactId: sigReq.contact_id ?? null, serviceDeliveryId: sigReq.service_delivery_id ?? null,
          })
          if (routed.route === "store") {
            await supabaseAdmin.from("signature_requests").update({ signed_pdf_drive_id: routed.pointer } as never).eq("id", sigReq.id)
            if (sigReq.service_delivery_id) {
              // eslint-disable-next-line no-restricted-syntax -- same stamp as the Drive path below (deferred migration, dev_task 7ebb1e0c)
              await supabaseAdmin.from("documents").update({ flow_stage: "Signed" } as never).eq("id", routed.documentRowId)
            }
            results.push("storage_save: ok")
            // the client is told about the new document exactly as when the Drive path makes it visible
            const { notifyClientsOfNewDocument } = await import("@/lib/portal/document-alerts")
            notifyClientsOfNewDocument(routed.documentRowId).catch((e) =>
              console.warn("[signature-request-signed] new-document alert failed:", e instanceof Error ? e.message : String(e)))
          }
        }
      } catch (err) {
        results.push(`storage_save: error - ${err instanceof Error ? err.message : "unknown"}`)
        // could not even tell where the files live: file NOTHING (never guess Drive)
        if (!stateKnown) switched = true
      }
    }

    // 1. A company with no storage: nothing is written to Drive any more (Stop Drive S2). The signed PDF stays safe in the
    //    signed-documents bucket and step 1b below still registers it for a flow-bound request; staff are alarmed, never a silent skip.
    // (a person-level agreement has no company: nothing to file in a company folder and nothing to alarm about; a failed lookup
    //  is reported on its own line and never stops the steps after it)
    if (!switched && sigReq.signed_pdf_path && sigReq.account_id) {
      try {
        const { legacyDriveForAccount, raiseDriveWriteRefused } = await import("@/lib/crm-store/legacy-drive")
        const legacy = await legacyDriveForAccount(sigReq.account_id)
        results.push(`drive_upload: error - ${await raiseDriveWriteRefused({ flow: "signature-request-signed", accountId: sigReq.account_id, reason: legacy.reason, detail: sigReq.document_name })}`)
      } catch (err) {
        results.push(`drive_upload: error - ${err instanceof Error ? err.message : "could not check where this company's files live"}`)
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
    if (!switched && sigReq.signed_pdf_path && sigReq.service_delivery_id) {
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
            category: 5, // Correspondence
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
        switched ? `The signed document has been saved in the client's new storage.` : `The signed document is NOT filed in the CRM storage (this company has no document storage). It is kept in the signing bucket — add it by hand where it belongs.`,
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
