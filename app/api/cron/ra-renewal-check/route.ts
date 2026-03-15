export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"

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
          task_title: `Rinnovare RA su Harbor per ${account.company_name} — scadenza ${account.ra_renewal_date}`,
          assigned_to: "Luca",
          status: "To Do",
          priority: "High",
          category: "Filing",
          due_date: account.ra_renewal_date,
          account_id: account.id,
          delivery_id: sd?.id,
          description: `Accedere a Harbor Compliance, cercare ${account.company_name}, autorizzare rinnovo, pagare $35, scaricare conferma, upload su Drive.`,
        })

      created++
      results.push({ company: account.company_name, action: "created SD + task" })
    }

    // Log to cron_log
    await supabaseAdmin
      .from("cron_log")
      .insert({
        endpoint: "/api/cron/ra-renewal-check",
        status: "success",
        details: { checked: accounts.length, created, skipped, results },
        executed_at: new Date().toISOString(),
      })

    return NextResponse.json({ ok: true, checked: accounts.length, created, skipped, results })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    await supabaseAdmin
      .from("cron_log")
      .insert({ endpoint: "/api/cron/ra-renewal-check", status: "error", error_message: msg, executed_at: new Date().toISOString() })
      .then(() => {})
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
