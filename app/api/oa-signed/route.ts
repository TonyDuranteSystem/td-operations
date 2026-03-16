/**
 * POST /api/oa-signed
 *
 * Called by the OA frontend after the client signs.
 * 1. Sends email notification to support@
 * 2. Advances service delivery stage (if applicable)
 * 3. Creates task for next step
 *
 * Body: { oa_id: string, token: string }
 * No auth required (public endpoint — only triggers internal notifications)
 */

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { oa_id, token } = body as { oa_id?: string; token?: string }

    if (!oa_id || !token) {
      return NextResponse.json({ error: "oa_id and token required" }, { status: 400 })
    }

    // Fetch OA record
    const { data: oa, error: oaErr } = await supabaseAdmin
      .from("oa_agreements")
      .select("id, token, company_name, account_id, contact_id, entity_type, manager_name, status")
      .eq("id", oa_id)
      .eq("token", token)
      .single()

    if (oaErr || !oa) {
      return NextResponse.json({ error: "OA not found" }, { status: 404 })
    }

    if (oa.status !== "signed") {
      return NextResponse.json({ error: "OA not signed" }, { status: 400 })
    }

    const results: { step: string; status: string; detail?: string }[] = []

    // ─── 1. EMAIL NOTIFICATION TO SUPPORT ───
    try {
      const { gmailPost } = await import("@/lib/gmail")

      const subject = `OA Signed: ${oa.company_name}`
      const body = [
        `The Operating Agreement for ${oa.company_name} has been signed.`,
        ``,
        `Entity Type: ${oa.entity_type || "SMLLC"}`,
        `Manager: ${oa.manager_name || "N/A"}`,
        `Token: ${oa.token}`,
        ``,
        `Admin Preview: https://td-operations.vercel.app/operating-agreement/${oa.token}?preview=td`,
      ].join("\n")

      const mimeHeaders = [
        `From: Tony Durante LLC <support@tonydurante.us>`,
        `To: support@tonydurante.us`,
        `Subject: ${subject}`,
        "MIME-Version: 1.0",
        `Content-Type: text/plain; charset=utf-8`,
        "Content-Transfer-Encoding: base64",
      ]
      const rawEmail = [...mimeHeaders, "", Buffer.from(body).toString("base64")].join("\r\n")
      const encodedRaw = Buffer.from(rawEmail).toString("base64url")

      await gmailPost("/messages/send", { raw: encodedRaw })
      results.push({ step: "email_notification", status: "ok", detail: "Notified support@" })
    } catch (e) {
      results.push({ step: "email_notification", status: "error", detail: e instanceof Error ? e.message : String(e) })
    }

    // ─── 2. ADVANCE SERVICE DELIVERY STAGE (if Company Formation pipeline) ───
    if (oa.account_id) {
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
          // OA signed typically happens during Post-Formation stage
          // Log OA signed event in stage_history but don't auto-advance
          // (stage advancement is managed by sd_advance_stage tool)
          const history = Array.isArray(sd.stage_history) ? sd.stage_history : []
          history.push({
            event: "oa_signed",
            at: new Date().toISOString(),
            note: `Operating Agreement signed for ${oa.company_name}`,
          })

          await supabaseAdmin
            .from("service_deliveries")
            .update({ stage_history: history })
            .eq("id", sd.id)

          results.push({ step: "sd_history", status: "ok", detail: `Updated SD ${sd.id} history (stage: ${sd.stage})` })
        } else {
          results.push({ step: "sd_history", status: "skipped", detail: "No active Company Formation SD found" })
        }
      } catch (e) {
        results.push({ step: "sd_history", status: "error", detail: e instanceof Error ? e.message : String(e) })
      }
    }

    return NextResponse.json({ ok: true, results })
  } catch (err) {
    console.error("[oa-signed]", err)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
