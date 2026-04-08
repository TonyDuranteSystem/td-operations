/**
 * POST /api/oa-signed
 *
 * Called by the OA frontend after the client signs.
 * For SMLLC: same as before (email + SD history + Drive upload)
 * For MMLLC: handles partial (member_index present) vs complete signing
 *
 * Body: { oa_id: string, token: string, member_index?: number }
 * No auth required (public endpoint — only triggers internal notifications)
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { APP_BASE_URL } from "@/lib/config"
import { autoSaveDocument } from "@/lib/portal/auto-save-document"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { oa_id, token, member_index } = body as { oa_id?: string; token?: string; member_index?: number }

    if (!oa_id || !token) {
      return NextResponse.json({ error: "oa_id and token required" }, { status: 400 })
    }

    // Fetch OA record
    const { data: oa, error: oaErr } = await supabaseAdmin
      .from("oa_agreements")
      .select("id, token, company_name, account_id, contact_id, entity_type, manager_name, status, total_signers, signed_count")
      .eq("id", oa_id)
      .eq("token", token)
      .single()

    if (oaErr || !oa) {
      return NextResponse.json({ error: "OA not found" }, { status: 404 })
    }

    const results: { step: string; status: string; detail?: string }[] = []
    const isMMLC = (oa.entity_type === "MMLLC") && (oa.total_signers || 1) > 1
    const isFullySigned = oa.status === "signed"
    const isPartial = isMMLC && !isFullySigned

    // Get signer name for notifications
    let signerName = "Member"
    if (typeof member_index === "number" && isMMLC) {
      const { data: sig } = await supabaseAdmin
        .from("oa_signatures")
        .select("member_name")
        .eq("oa_id", oa.id)
        .eq("member_index", member_index)
        .single()
      if (sig) signerName = sig.member_name
    }

    // ─── 1. EMAIL NOTIFICATION TO SUPPORT ───
    try {
      const { gmailPost } = await import("@/lib/gmail")

      const subject = isPartial
        ? `OA Partial Sign: ${oa.company_name} (${oa.signed_count}/${oa.total_signers})`
        : `OA Signed: ${oa.company_name}`

      const bodyLines = isPartial
        ? [
            `${signerName} has signed the Operating Agreement for ${oa.company_name}.`,
            ``,
            `Progress: ${oa.signed_count}/${oa.total_signers} members signed`,
            `Entity Type: ${oa.entity_type || "SMLLC"}`,
            `Token: ${oa.token}`,
            ``,
            `The agreement is NOT yet fully executed. Remaining members must still sign.`,
            ``,
            `Admin Preview: ${APP_BASE_URL}/operating-agreement/${oa.token}?preview=td`,
          ]
        : [
            `The Operating Agreement for ${oa.company_name} has been ${isMMLC ? "fully " : ""}signed.`,
            ``,
            `Entity Type: ${oa.entity_type || "SMLLC"}`,
            `Manager: ${oa.manager_name || "N/A"}`,
            isMMLC ? `All ${oa.total_signers} members have signed.` : null,
            `Token: ${oa.token}`,
            ``,
            `Admin Preview: ${APP_BASE_URL}/operating-agreement/${oa.token}?preview=td`,
          ].filter(Boolean)

      const emailBody = bodyLines.join("\n")
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
      results.push({ step: "email_notification", status: "ok", detail: isPartial ? `Partial sign (${signerName})` : "Notified support@" })
    } catch (e) {
      results.push({ step: "email_notification", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // ─── ONLY DO DRIVE UPLOAD + SD HISTORY WHEN FULLY SIGNED ───
    if (isFullySigned && oa.account_id) {
      // ─── 2. ADVANCE SERVICE DELIVERY STAGE ───
      try {
        const { data: sd } = await supabaseAdmin
          .from("service_deliveries")
          .select("id, stage, stage_order, stage_history, pipeline")
          .eq("account_id", oa.account_id)
          .eq("service_type", "Company Formation")
          .eq("status", "active")
          .limit(1)
          .maybeSingle()

        if (sd) {
          const history = Array.isArray(sd.stage_history) ? sd.stage_history : []
          history.push({
            event: "oa_signed",
            at: new Date().toISOString(),
            note: `Operating Agreement ${isMMLC ? "fully " : ""}signed for ${oa.company_name}${isMMLC ? ` (all ${oa.total_signers} members)` : ""}`,
          })

          const postFormationStages = ["Post-Formation", "EIN Received", "Welcome Package", "Client Onboarding"]
          const isPostFormation = postFormationStages.some(s => sd.stage?.includes(s))
          if (isPostFormation) {
            history.push({
              event: "oa_milestone",
              at: new Date().toISOString(),
              note: `OA signed during ${sd.stage} — post-formation document complete`,
            })
          }

          await supabaseAdmin
            .from("service_deliveries")
            .update({ stage_history: history, updated_at: new Date().toISOString() })
            .eq("id", sd.id)

          results.push({ step: "sd_history", status: "ok", detail: `Updated SD ${sd.id} history` })
        } else {
          results.push({ step: "sd_history", status: "skipped", detail: "No active Company Formation SD found" })
        }
      } catch (e) {
        results.push({ step: "sd_history", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }

      // ─── 3. AUTO-UPLOAD SIGNED PDF TO DRIVE ───
      try {
        const { data: acct } = await supabaseAdmin
          .from("accounts")
          .select("drive_folder_id")
          .eq("id", oa.account_id)
          .single()

        if (acct?.drive_folder_id) {
          const { listFolder, uploadBinaryToDrive } = await import("@/lib/google-drive")
          const folderResult = await listFolder(acct.drive_folder_id) as { files?: { id: string; name: string; mimeType: string }[] }
          const companyFolder = folderResult.files?.find(f =>
            f.name.includes("Company") && f.mimeType === "application/vnd.google-apps.folder"
          )
          const targetFolderId = companyFolder?.id || acct.drive_folder_id

          const { data: files } = await supabaseAdmin.storage
            .from("signed-oa")
            .list(oa.token, { limit: 1, sortBy: { column: "created_at", order: "desc" } })

          if (files?.length) {
            const pdfFile = files.find(f => f.name.endsWith('.pdf'))
            if (pdfFile) {
              const { data: blob } = await supabaseAdmin.storage
                .from("signed-oa")
                .download(`${oa.token}/${pdfFile.name}`)

              if (blob) {
                const arrayBuffer = await blob.arrayBuffer()
                const fileData = Buffer.from(arrayBuffer)
                const fileName = `Operating Agreement - ${oa.company_name} (Signed).pdf`

                const driveResult = await uploadBinaryToDrive(fileName, fileData, "application/pdf", targetFolderId) as { id: string }
                results.push({ step: "drive_upload", status: "ok", detail: `Uploaded to Drive: ${driveResult.id}` })

                if (oa.account_id) {
                  await autoSaveDocument({
                    accountId: oa.account_id,
                    fileName,
                    documentType: 'Operating Agreement',
                    category: 1,
                    driveFileId: driveResult.id,
                    portalVisible: true,
                  })
                }
              } else {
                results.push({ step: "drive_upload", status: "error", detail: "Could not download PDF from Storage" })
              }
            } else {
              results.push({ step: "drive_upload", status: "skipped", detail: "No PDF found in Storage" })
            }
          } else {
            results.push({ step: "drive_upload", status: "skipped", detail: "No files in Storage" })
          }
        } else {
          results.push({ step: "drive_upload", status: "skipped", detail: "No drive_folder_id on account" })
        }
      } catch (e) {
        results.push({ step: "drive_upload", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    } else if (isPartial) {
      results.push({ step: "drive_upload", status: "skipped", detail: `Partial signing (${oa.signed_count}/${oa.total_signers}) — Drive upload deferred until all sign` })
    }

    // Log to action_log for CRM Recent Activity + realtime notifications
    try {
      await supabaseAdmin.from("action_log").insert({
        actor: "system",
        action_type: isFullySigned ? "oa_signed" : "oa_partial_signed",
        table_name: "oa_agreements",
        record_id: oa.id,
        account_id: oa.account_id || null,
        contact_id: oa.contact_id || null,
        summary: isFullySigned
          ? `Operating Agreement signed: ${oa.company_name}`
          : `OA partial sign: ${oa.company_name} (${oa.signed_count}/${oa.total_signers})`,
        details: { token, company_name: oa.company_name, entity_type: oa.entity_type, is_fully_signed: isFullySigned },
      })
    } catch { /* non-blocking */ }

    return NextResponse.json({ ok: true, results })
  } catch (err) {
    console.error("[oa-signed]", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
