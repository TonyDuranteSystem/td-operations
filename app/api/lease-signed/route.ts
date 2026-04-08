/**
 * POST /api/lease-signed
 *
 * Called by the Lease frontend after the client signs.
 * 1. Sends email notification to support@
 * 2. Updates service delivery stage_history (if applicable)
 * 3. Creates task for next step (upload to Drive, etc.)
 *
 * Body: { lease_id: string, token: string }
 * No auth required (public endpoint — only triggers internal notifications)
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { autoSaveDocument } from "@/lib/portal/auto-save-document"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { lease_id, token } = body as { lease_id?: string; token?: string }

    if (!lease_id || !token) {
      return NextResponse.json({ error: "lease_id and token required" }, { status: 400 })
    }

    // Fetch lease record
    const { data: lease, error: leaseErr } = await supabaseAdmin
      .from("lease_agreements")
      .select("id, token, tenant_company, account_id, contact_id, suite_number, status, pdf_storage_path")
      .eq("id", lease_id)
      .eq("token", token)
      .single()

    if (leaseErr || !lease) {
      return NextResponse.json({ error: "Lease not found" }, { status: 404 })
    }

    if (lease.status !== "signed") {
      return NextResponse.json({ error: "Lease not signed" }, { status: 400 })
    }

    const results: { step: string; status: string; detail?: string }[] = []

    // ─── 1. EMAIL NOTIFICATION TO SUPPORT ───
    try {
      const { gmailPost } = await import("@/lib/gmail")

      const subject = `Lease Signed: ${lease.tenant_company} (Suite ${lease.suite_number})`
      const emailBody = [
        `The Lease Agreement for ${lease.tenant_company} has been signed.`,
        ``,
        `Suite: ${lease.suite_number}`,
        `Token: ${lease.token}`,
        ``,
        `Admin Preview: ${APP_BASE_URL}/lease/${lease.token}?preview=td`,
        ``,
        `Next steps:`,
        `- Upload signed PDF to Drive (Company folder → 1. Company)`,
        `- Confirm security deposit payment`,
      ].join("\n")

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
      results.push({ step: "email_notification", status: "ok", detail: "Notified support@" })
    } catch (e) {
      results.push({ step: "email_notification", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // ─── 2. UPDATE SERVICE DELIVERY HISTORY ───
    if (lease.account_id) {
      try {
        // Check both Company Formation and Client Onboarding pipelines
        const { data: sd } = await supabaseAdmin
          .from("service_deliveries")
          .select("id, stage, stage_order, stage_history, service_type")
          .eq("account_id", lease.account_id)
          .eq("status", "active")
          .in("service_type", ["Company Formation", "Client Onboarding"])
          .limit(1)
          .maybeSingle()

        if (sd) {
          const history = Array.isArray(sd.stage_history) ? sd.stage_history : []
          history.push({
            event: "lease_signed",
            at: new Date().toISOString(),
            note: `Lease Agreement signed for ${lease.tenant_company} (Suite ${lease.suite_number})`,
          })

          await supabaseAdmin
            .from("service_deliveries")
            .update({ stage_history: history })
            .eq("id", sd.id)

          results.push({ step: "sd_history", status: "ok", detail: `Updated SD ${sd.id} history (${sd.service_type}, stage: ${sd.stage})` })
        } else {
          results.push({ step: "sd_history", status: "skipped", detail: "No active Formation/Onboarding SD found" })
        }
      } catch (e) {
        results.push({ step: "sd_history", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }

      // ─── 3. ADVANCE CMRA MAILING ADDRESS SD ───
      try {
        const { data: cmraSd } = await supabaseAdmin
          .from("service_deliveries")
          .select("id, stage, stage_history")
          .eq("account_id", lease.account_id)
          .eq("service_type", "CMRA Mailing Address")
          .eq("status", "active")
          .limit(1)
          .maybeSingle()

        if (cmraSd && cmraSd.stage === "Lease Created") {
          const history = Array.isArray(cmraSd.stage_history) ? cmraSd.stage_history : []
          history.push({
            event: "lease_signed",
            at: new Date().toISOString(),
            note: `Lease signed for ${lease.tenant_company} (Suite ${lease.suite_number})`,
          })

          await supabaseAdmin
            .from("service_deliveries")
            .update({ stage: "Lease Signed", stage_history: history, updated_at: new Date().toISOString() })
            .eq("id", cmraSd.id)

          results.push({ step: "cmra_sd_advance", status: "ok", detail: `SD ${cmraSd.id} advanced: Lease Created → Lease Signed` })
        } else if (cmraSd) {
          results.push({ step: "cmra_sd_advance", status: "skipped", detail: `CMRA SD stage is "${cmraSd.stage}", not "Lease Created"` })
        } else {
          results.push({ step: "cmra_sd_advance", status: "skipped", detail: "No active CMRA Mailing Address SD found" })
        }
      } catch (e) {
        results.push({ step: "cmra_sd_advance", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }

      // ─── 4. CREATE TASK: PREPARE USPS FORM 1583 ───
      try {
        const taskTitle = `Prepare USPS Form 1583 - ${lease.tenant_company}`
        const { data: existingTask } = await supabaseAdmin
          .from("tasks")
          .select("id")
          .eq("task_title", taskTitle)
          .eq("account_id", lease.account_id)
          .maybeSingle()

        if (!existingTask) {
          await supabaseAdmin.from("tasks").insert({
            task_title: taskTitle,
            description: "Lease signed. Next: prepare Form 1583, collect IDs, notarize (Antonio).",
            assigned_to: "Luca",
            priority: "High",
            category: "CMRA",
            status: "To Do",
            account_id: lease.account_id,
            created_by: "System",
          })
          results.push({ step: "task_form_1583", status: "ok", detail: taskTitle })
        } else {
          results.push({ step: "task_form_1583", status: "skipped", detail: "Task already exists" })
        }
      } catch (e) {
        results.push({ step: "task_form_1583", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }

      // ─── 5. AUTO-UPLOAD SIGNED PDF TO DRIVE ───
      try {
        const { data: acct } = await supabaseAdmin
          .from("accounts")
          .select("drive_folder_id")
          .eq("id", lease.account_id)
          .single()

        if (acct?.drive_folder_id) {
          const { listFolder, uploadBinaryToDrive } = await import("@/lib/google-drive")
          const folderResult = await listFolder(acct.drive_folder_id) as { files?: { id: string; name: string; mimeType: string }[] }
          const companyFolder = folderResult.files?.find(f =>
            f.name.includes("Company") && f.mimeType === "application/vnd.google-apps.folder"
          )
          const targetFolderId = companyFolder?.id || acct.drive_folder_id

          // Download signed PDF from Storage
          const pdfPath = lease.pdf_storage_path || `${lease.token}/lease-signed.pdf`
          const { data: blob } = await supabaseAdmin.storage
            .from("signed-leases")
            .download(pdfPath)

          if (blob) {
            const arrayBuffer = await blob.arrayBuffer()
            const fileData = Buffer.from(arrayBuffer)
            const fileName = `Lease Agreement - ${lease.tenant_company} (Suite ${lease.suite_number}, Signed).pdf`

            const driveResult = await uploadBinaryToDrive(fileName, fileData, "application/pdf", targetFolderId) as { id: string }
            results.push({ step: "drive_upload", status: "ok", detail: `Uploaded to Drive: ${driveResult.id}` })

            // Auto-save to documents table for portal
            await autoSaveDocument({
              accountId: lease.account_id,
              fileName,
              documentType: 'Lease Agreement',
              category: 1, // Company
              driveFileId: driveResult.id,
              portalVisible: true,
            })
          } else {
            results.push({ step: "drive_upload", status: "error", detail: "Could not download PDF from Storage" })
          }
        } else {
          results.push({ step: "drive_upload", status: "skipped", detail: "No drive_folder_id on account" })
        }
      } catch (e) {
        results.push({ step: "drive_upload", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    // Log to action_log for CRM Recent Activity + realtime notifications
    try {
      await supabaseAdmin.from("action_log").insert({
        actor: "system",
        action_type: "lease_signed",
        table_name: "lease_agreements",
        record_id: lease.id,
        account_id: lease.account_id || null,
        contact_id: lease.contact_id || null,
        summary: `Lease signed: ${lease.tenant_company} (Suite ${lease.suite_number})`,
        details: { token, tenant_company: lease.tenant_company, suite_number: lease.suite_number },
      })
    } catch { /* non-blocking */ }

    return NextResponse.json({ ok: true, results })
  } catch (err) {
    console.error("[lease-signed]", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
