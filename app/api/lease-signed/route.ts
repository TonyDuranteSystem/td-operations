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
        `Admin Preview: https://td-operations.vercel.app/lease/${lease.token}?preview=td`,
        ``,
        `Next steps:`,
        `- Upload signed PDF to Drive (Company folder → 1. Company)`,
        `- Confirm security deposit payment`,
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

      // ─── 3. CREATE TASK: Upload signed lease to Drive ───
      try {
        const taskTitle = `Upload signed lease to Drive — ${lease.tenant_company}`
        const { data: existingTask } = await supabaseAdmin
          .from("tasks")
          .select("id")
          .eq("task_title", taskTitle)
          .eq("account_id", lease.account_id)
          .maybeSingle()

        if (!existingTask) {
          await supabaseAdmin.from("tasks").insert({
            task_title: taskTitle,
            description: [
              `Lease signed by ${lease.tenant_company} (Suite ${lease.suite_number}).`,
              ``,
              `PDF in Storage: signed-leases/${lease.pdf_storage_path || lease.token}`,
              ``,
              `Action: Download from Supabase Storage and upload to Drive → Company folder → 1. Company`,
            ].join("\n"),
            assigned_to: "Luca",
            priority: "Normal",
            category: "Document",
            status: "To Do",
            account_id: lease.account_id,
            created_by: "System",
          })
          results.push({ step: "task_drive_upload", status: "ok", detail: "Task created: upload signed lease to Drive" })
        } else {
          results.push({ step: "task_drive_upload", status: "skipped", detail: "Already exists" })
        }
      } catch (e) {
        results.push({ step: "task_drive_upload", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    return NextResponse.json({ ok: true, results })
  } catch (err) {
    console.error("[lease-signed]", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
