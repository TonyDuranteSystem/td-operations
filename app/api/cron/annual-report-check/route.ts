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
      // Check if SD already exists
      const { data: existingSD } = await supabaseAdmin
        .from("service_deliveries")
        .select("id")
        .eq("account_id", account.id)
        .eq("service_type", "State Annual Report")
        .eq("status", "active")
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
        // Create task for Antonio — payment issue
        await supabaseAdmin
          .from("tasks")
          .insert({
            task_title: `Annual Report bloccato — ${account.company_name} non ha pagato`,
            assigned_to: "Antonio",
            status: "To Do",
            priority: "Urgent",
            category: "Payment",
            due_date: account.annual_report_due_date,
            account_id: account.id,
            delivery_id: sd?.id,
            description: `Annual report due ${account.annual_report_due_date} ma pagamento overdue. Risolvere pagamento prima di procedere.`,
          })
        blocked++
        results.push({ company: account.company_name, action: "created SD (BLOCKED) + task Antonio" })
      } else {
        // Create task for Luca — filing
        await supabaseAdmin
          .from("tasks")
          .insert({
            task_title: `Filing Annual Report per ${account.company_name} — deadline ${account.annual_report_due_date}`,
            assigned_to: "Luca",
            status: "To Do",
            priority: "High",
            category: "Filing",
            due_date: account.annual_report_due_date,
            account_id: account.id,
            delivery_id: sd?.id,
            description: `Accedere a ${portal}, cercare ${account.company_name}, compilare e sottomettere annual report, pagare ${fee}, scaricare ricevuta, upload su Drive.`,
          })
        created++
        results.push({ company: account.company_name, action: "created SD + task Luca" })
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
