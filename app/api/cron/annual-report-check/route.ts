export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"

/**
 * Cron: Annual Report Check
 * Schedule: daily at 9am UTC
 *
 * Scans active Client accounts where annual_report_due_date is within 45 days.
 * Creates service_delivery + task for Luca if not already created.
 * NM accounts are skipped (no annual report required).
 * Blocked if installment not paid.
 * SOP: State Annual Report v3.1
 */
export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization")
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const today = new Date()
    const fortyFiveDaysFromNow = new Date(today)
    fortyFiveDaysFromNow.setDate(fortyFiveDaysFromNow.getDate() + 45)

    // Find active Client accounts with annual report due within 45 days
    // Exclude New Mexico (no annual report required)
    const { data: accounts, error: qErr } = await supabaseAdmin
      .from("accounts")
      .select("id, company_name, annual_report_due_date, state_of_formation, entity_type")
      .eq("status", "Active")
      .eq("account_type", "Client")
      .not("annual_report_due_date", "is", null)
      .neq("state_of_formation", "New Mexico")
      .lte("annual_report_due_date", fortyFiveDaysFromNow.toISOString().split("T")[0])
      .gte("annual_report_due_date", today.toISOString().split("T")[0])

    if (qErr) throw qErr
    if (!accounts?.length) {
      return NextResponse.json({ ok: true, message: "No annual reports due", checked: 0, created: 0 })
    }

    // State portal URLs for task descriptions
    const statePortals: Record<string, string> = {
      "Wyoming": "sos.wyo.gov",
      "Florida": "sunbiz.org",
      "Delaware": "corp.delaware.gov",
      "Massachusetts": "sec.state.ma.us",
    }

    const stateFees: Record<string, string> = {
      "Wyoming": "$60",
      "Florida": "$138.75",
      "Delaware": "$300",
      "Massachusetts": "$500",
    }

    let created = 0
    let skipped = 0
    let blocked = 0
    const results: { company: string; action: string }[] = []

    for (const account of accounts) {
      // Check if SD already exists (active or blocked)
      const { data: existingSD } = await supabaseAdmin
        .from("service_deliveries")
        .select("id")
        .eq("account_id", account.id)
        .eq("service_type", "State Annual Report")
        .in("status", ["active", "blocked"])
        .limit(1)

      if (existingSD?.length) {
        skipped++
        results.push({ company: account.company_name, action: "skipped — SD already exists" })
        continue
      }

      // Check payment status — look for overdue payments
      const { data: overduePayments } = await supabaseAdmin
        .from("payments")
        .select("id")
        .eq("account_id", account.id)
        .in("status", ["Overdue", "Delinquent"])
        .limit(1)

      const isBlocked = overduePayments?.length ? true : false

      // Get first pipeline stage
      const { data: firstStage } = await supabaseAdmin
        .from("pipeline_stages")
        .select("*")
        .eq("service_type", "State Annual Report")
        .order("stage_order")
        .limit(1)
        .single()

      const state = account.state_of_formation || "Unknown"
      const portal = statePortals[state] || "state portal"
      const fee = stateFees[state] || "TBD"

      // Create service delivery
      const sdStatus = isBlocked ? "blocked" : "active"
      const { data: sd, error: sdErr } = await supabaseAdmin
        .from("service_deliveries")
        .insert({
          service_name: `Annual Report — ${account.company_name}`,
          service_type: "State Annual Report",
          pipeline: "State Annual Report",
          stage: firstStage?.stage_name || "Upcoming",
          stage_order: firstStage?.stage_order || 1,
          stage_entered_at: new Date().toISOString(),
          stage_history: [{ to_stage: "Upcoming", to_order: 1, advanced_at: new Date().toISOString(), notes: isBlocked ? "Auto-created by cron — BLOCKED payment overdue" : "Auto-created by cron" }],
          account_id: account.id,
          status: sdStatus,
          start_date: new Date().toISOString().split("T")[0],
          due_date: account.annual_report_due_date,
          assigned_to: "Luca",
          notes: isBlocked
            ? `BLOCKED — Payment overdue. Annual report due ${account.annual_report_due_date} (${state}, ${fee})`
            : `Auto-created: Annual report due ${account.annual_report_due_date} (${state}, ${fee})`,
        })
        .select("id")
        .single()

      if (sdErr) {
        results.push({ company: account.company_name, action: `error: ${sdErr.message}` })
        continue
      }

      if (isBlocked) {
        // Dedup: check if task already exists for this account
        const { data: existingTask } = await supabaseAdmin
          .from("tasks")
          .select("id")
          .eq("account_id", account.id)
          .like("task_title", "Annual Report blocked%")
          .eq("status", "To Do")
          .limit(1)

        if (!existingTask?.length) {
          await supabaseAdmin
            .from("tasks")
            .insert({
              task_title: `Annual Report blocked — ${account.company_name} has overdue payment`,
              assigned_to: "Antonio",
              status: "To Do",
              priority: "Urgent",
              category: "Payment",
              due_date: account.annual_report_due_date,
              account_id: account.id,
              delivery_id: sd?.id,
              description: `Annual report due ${account.annual_report_due_date} but payment is overdue. Resolve payment before proceeding.`,
            })
        }
        blocked++
        results.push({ company: account.company_name, action: existingTask?.length ? "created SD (BLOCKED) — task already exists" : "created SD (BLOCKED) + task Antonio" })
      } else {
        // Dedup: check if task already exists for this account
        const { data: existingTask } = await supabaseAdmin
          .from("tasks")
          .select("id")
          .eq("account_id", account.id)
          .like("task_title", "File Annual Report for%")
          .eq("status", "To Do")
          .limit(1)

        if (!existingTask?.length) {
          await supabaseAdmin
            .from("tasks")
            .insert({
              task_title: `File Annual Report for ${account.company_name} — deadline ${account.annual_report_due_date}`,
              assigned_to: "Luca",
              status: "To Do",
              priority: "High",
              category: "Filing",
              due_date: account.annual_report_due_date,
              account_id: account.id,
              delivery_id: sd?.id,
              description: `Go to ${portal}, search for ${account.company_name}, complete and submit annual report, pay ${fee}, download receipt, upload to Drive.`,
            })
        }
        created++
        results.push({ company: account.company_name, action: existingTask?.length ? "created SD — task already exists" : "created SD + task Luca" })
      }
    }

    // Log to cron_log
    await supabaseAdmin
      .from("cron_log")
      .insert({
        endpoint: "/api/cron/annual-report-check",
        status: "success",
        details: { checked: accounts.length, created, skipped, blocked, results },
        executed_at: new Date().toISOString(),
      })

    // Send email report if there are new filings or blocked accounts
    if (created > 0 || blocked > 0) {
      try {
        const { gmailPost } = await import("@/lib/gmail")

        const newRows = results
          .filter(r => r.action.includes("task Luca"))
          .map(r => `<tr><td style="padding:6px 12px;border:1px solid #ddd">${r.company}</td><td style="padding:6px 12px;border:1px solid #ddd">✅ SD + Task Luca</td></tr>`)
          .join("")

        const blockedRows = results
          .filter(r => r.action.includes("BLOCKED"))
          .map(r => `<tr><td style="padding:6px 12px;border:1px solid #ddd;color:#c00">${r.company}</td><td style="padding:6px 12px;border:1px solid #ddd;color:#c00">🚫 Blocked — overdue payment</td></tr>`)
          .join("")

        const skippedRows = results
          .filter(r => r.action.includes("skipped"))
          .map(r => `<tr><td style="padding:6px 12px;border:1px solid #ddd;color:#888">${r.company}</td><td style="padding:6px 12px;border:1px solid #ddd;color:#888">${r.action}</td></tr>`)
          .join("")

        const html = `
          <h2>📋 Annual Report Check — ${today.toISOString().split("T")[0]}</h2>
          <p><strong>${created}</strong> new filings | <strong>${blocked}</strong> blocked | <strong>${skipped}</strong> skipped | <strong>${accounts.length}</strong> checked</p>
          ${newRows ? `<h3>✅ New filings to do (Luca)</h3>
          <table style="border-collapse:collapse;width:100%">
            <tr style="background:#f5f5f5"><th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Company</th><th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Action</th></tr>
            ${newRows}
          </table>` : ""}
          ${blockedRows ? `<h3 style="margin-top:16px">🚫 Blocked — overdue payment (Antonio)</h3>
          <table style="border-collapse:collapse;width:100%">
            <tr style="background:#f5f5f5"><th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Company</th><th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Status</th></tr>
            ${blockedRows}
          </table>` : ""}
          ${skippedRows ? `<h3 style="margin-top:16px;color:#888">⏭️ Skipped</h3>
          <table style="border-collapse:collapse;width:100%">
            <tr style="background:#f5f5f5"><th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Company</th><th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Reason</th></tr>
            ${skippedRows}
          </table>` : ""}
          <p style="margin-top:16px;color:#888;font-size:12px">Auto-generated by /api/cron/annual-report-check</p>
        `

        await gmailPost("/messages/send", {
          to: "support@tonydurante.us",
          subject: `📋 Annual Report: ${created} filing${blocked ? ` + ${blocked} blocked` : ""}`,
          htmlBody: html,
        })
      } catch (emailErr) {
        console.error("Annual Report email report failed:", emailErr)
      }
    }

    return NextResponse.json({ ok: true, checked: accounts.length, created, skipped, blocked, results })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    await supabaseAdmin
      .from("cron_log")
      .insert({ endpoint: "/api/cron/annual-report-check", status: "error", error_message: msg, executed_at: new Date().toISOString() })
      .then(() => {})
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
