export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"

/**
 * Cron: RA Renewal Check
 * Schedule: daily at 9am UTC
 *
 * Scans active Client accounts where ra_renewal_date is within 30 days.
 * Creates service_delivery + task for Luca if not already created.
 * Skips accounts with active Company Closure or Client Offboarding.
 * SOP: RA Renewal v3.1
 */
export async function GET(req: NextRequest) {
  const startTime = Date.now()
  try {
    const authHeader = req.headers.get("authorization")
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const today = new Date()
    const thirtyDaysFromNow = new Date(today)
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30)

    // Find active Client accounts with RA renewal within 30 days
    const { data: accounts, error: qErr } = await supabaseAdmin
      .from("accounts")
      .select("id, company_name, ra_renewal_date, state_of_formation")
      .eq("status", "Active")
      .eq("account_type", "Client")
      .not("ra_renewal_date", "is", null)
      .lte("ra_renewal_date", thirtyDaysFromNow.toISOString().split("T")[0])
      .gte("ra_renewal_date", today.toISOString().split("T")[0])

    if (qErr) throw qErr
    if (!accounts?.length) {
      return NextResponse.json({ ok: true, message: "No RA renewals due", checked: 0, created: 0 })
    }

    let created = 0
    let skipped = 0
    const results: { company: string; action: string }[] = []

    for (const account of accounts) {
      // Check if SD already exists for this account this year
      const { data: existingSD } = await supabaseAdmin
        .from("service_deliveries")
        .select("id")
        .eq("account_id", account.id)
        .eq("service_type", "State RA Renewal")
        .eq("status", "active")
        .limit(1)

      if (existingSD?.length) {
        skipped++
        results.push({ company: account.company_name, action: "skipped — SD already exists" })
        continue
      }

      // Check for active offboarding/closure
      const { data: closureSD } = await supabaseAdmin
        .from("service_deliveries")
        .select("id, service_type")
        .eq("account_id", account.id)
        .in("service_type", ["Company Closure", "Client Offboarding"])
        .eq("status", "active")
        .limit(1)

      if (closureSD?.length) {
        skipped++
        results.push({ company: account.company_name, action: `skipped — ${closureSD[0].service_type} active` })
        continue
      }

      // Get first pipeline stage
      const { data: firstStage } = await supabaseAdmin
        .from("pipeline_stages")
        .select("*")
        .eq("service_type", "State RA Renewal")
        .order("stage_order")
        .limit(1)
        .single()

      // Create service delivery
      const { data: sd, error: sdErr } = await supabaseAdmin
        .from("service_deliveries")
        .insert({
          service_name: `RA Renewal — ${account.company_name}`,
          service_type: "State RA Renewal",
          pipeline: "State RA Renewal",
          stage: firstStage?.stage_name || "Upcoming",
          stage_order: firstStage?.stage_order || 1,
          stage_entered_at: new Date().toISOString(),
          stage_history: [{ to_stage: "Upcoming", to_order: 1, advanced_at: new Date().toISOString(), notes: "Auto-created by cron" }],
          account_id: account.id,
          status: "active",
          start_date: new Date().toISOString().split("T")[0],
          due_date: account.ra_renewal_date,
          assigned_to: "Luca",
          notes: `Auto-created: RA renewal due ${account.ra_renewal_date}`,
        })
        .select("id")
        .single()

      if (sdErr) {
        results.push({ company: account.company_name, action: `error: ${sdErr.message}` })
        continue
      }

      // Create task for Luca
      await supabaseAdmin
        .from("tasks")
        .insert({
          task_title: `Renew RA on Harbor for ${account.company_name} — deadline ${account.ra_renewal_date}`,
          assigned_to: "Luca",
          status: "To Do",
          priority: "High",
          category: "Filing",
          due_date: account.ra_renewal_date,
          account_id: account.id,
          delivery_id: sd?.id,
          description: `Go to Harbor Compliance, search for ${account.company_name}, authorize renewal, pay $35, download confirmation, upload to Drive.`,
        })

      created++
      results.push({ company: account.company_name, action: "created SD + task" })
    }

    logCron({
      endpoint: "/api/cron/ra-renewal-check",
      status: "success",
      duration_ms: Date.now() - startTime,
      details: { checked: accounts.length, created, skipped, results },
    })

    // Send email report if there are new renewals
    if (created > 0) {
      try {
        const { gmailPost } = await import("@/lib/gmail")

        const renewalRows = results
          .filter(r => r.action === "created SD + task")
          .map(r => `<tr><td style="padding:6px 12px;border:1px solid #ddd">${r.company}</td><td style="padding:6px 12px;border:1px solid #ddd">SD + Task created</td></tr>`)
          .join("")

        const skippedRows = results
          .filter(r => r.action !== "created SD + task")
          .map(r => `<tr><td style="padding:6px 12px;border:1px solid #ddd;color:#888">${r.company}</td><td style="padding:6px 12px;border:1px solid #ddd;color:#888">${r.action}</td></tr>`)
          .join("")

        const html = `
          <h2>🔄 RA Renewal Report — ${today.toISOString().split("T")[0]}</h2>
          <p><strong>${created}</strong> new renewals | <strong>${skipped}</strong> skipped | <strong>${accounts.length}</strong> checked</p>
          <h3>✅ New renewals to do (assigned to Luca)</h3>
          <table style="border-collapse:collapse;width:100%">
            <tr style="background:#f5f5f5"><th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Company</th><th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Action</th></tr>
            ${renewalRows}
          </table>
          ${skippedRows ? `<h3 style="margin-top:16px">⏭️ Skipped</h3>
          <table style="border-collapse:collapse;width:100%">
            <tr style="background:#f5f5f5"><th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Company</th><th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Reason</th></tr>
            ${skippedRows}
          </table>` : ""}
          <p style="margin-top:16px;color:#888;font-size:12px">Auto-generated by /api/cron/ra-renewal-check</p>
        `

        await gmailPost("/messages/send", {
          to: "support@tonydurante.us",
          subject: `🔄 RA Renewal: ${created} new renewals to process`,
          htmlBody: html,
        })
      } catch (emailErr) {
        // Email failure is non-blocking — log but don't fail the cron
        console.error("RA Renewal email report failed:", emailErr)
      }
    }

    return NextResponse.json({ ok: true, checked: accounts.length, created, skipped, results })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    logCron({
      endpoint: "/api/cron/ra-renewal-check",
      status: "error",
      duration_ms: Date.now() - startTime,
      error_message: msg,
    })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
