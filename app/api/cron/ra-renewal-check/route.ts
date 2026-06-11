export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"
import { emitActionNeeded } from "@/lib/notifications/act-event"

/**
 * Cron: RA Renewal Check
 * Schedule: daily at 9am UTC
 *
 * Scans active Client accounts where ra_renewal_date is within 30 days.
 * Creates service_delivery + task for Luca if not already created.
 * Skips accounts with active Company Closure or Client Offboarding.
 * Blocked if 1st installment not paid (overdue payments) — task to Antonio.
 * SOP: RA Renewal v7.1 (was v7.0 "non-postponable" — Antonio 2026-05-05:
 * "no service if first installment unpaid", overrides the old rule).
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
    let blocked = 0
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

      // Check payment status — overdue payments block the renewal (SOP v7.1).
      // Antonio 2026-05-05: "no service if first installment unpaid" overrides
      // the old SOP v7.0 'non-postponable' rule. Mirrors annual-report-check.
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
        .eq("service_type", "State RA Renewal")
        .order("stage_order")
        .limit(1)
        .single()

      // Create service delivery
      const sdStatus = isBlocked ? "blocked" : "active"
      // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw service_deliveries.insert in cron; refactor deferred (dev_task 7ebb1e0c)
      const { data: sd, error: sdErr } = await supabaseAdmin
        .from("service_deliveries")
        .insert({
          service_name: `RA Renewal — ${account.company_name}`,
          service_type: "State RA Renewal",
          pipeline: "State RA Renewal",
          stage: firstStage?.stage_name || "Upcoming",
          stage_order: firstStage?.stage_order || 1,
          stage_entered_at: new Date().toISOString(),
          stage_history: [{
            to_stage: "Upcoming",
            to_order: 1,
            advanced_at: new Date().toISOString(),
            notes: isBlocked ? "Auto-created by cron — BLOCKED payment overdue" : "Auto-created by cron",
          }],
          account_id: account.id,
          status: sdStatus,
          start_date: new Date().toISOString().split("T")[0],
          due_date: account.ra_renewal_date,
          assigned_to: "Luca",
          notes: isBlocked
            ? `BLOCKED — Payment overdue. RA renewal due ${account.ra_renewal_date}`
            : `Auto-created: RA renewal due ${account.ra_renewal_date}`,
        })
        .select("id")
        .single()

      if (sdErr) {
        results.push({ company: account.company_name, action: `error: ${sdErr.message}` })
        continue
      }

      if (isBlocked) {
        // Dedup: check if blocked-task already exists for this account
        const { data: existingTask } = await supabaseAdmin
          .from("tasks")
          .select("id")
          .eq("account_id", account.id)
          .like("task_title", "RA Renewal blocked%")
          .eq("status", "To Do")
          .limit(1)

        if (!existingTask?.length) {
          // eslint-disable-next-line no-restricted-syntax -- pre-P2.4 raw tasks.insert in cron; refactor deferred (dev_task 7ebb1e0c)
          await supabaseAdmin
            .from("tasks")
            .insert({
              task_title: `RA Renewal blocked — ${account.company_name} has overdue payment`,
              assigned_to: "Antonio",
              status: "To Do",
              priority: "Urgent",
              category: "Payment",
              due_date: account.ra_renewal_date,
              account_id: account.id,
              delivery_id: sd?.id,
              description: `RA renewal due ${account.ra_renewal_date} but payment is overdue. Resolve payment before proceeding.`,
            })
        }
        blocked++
        results.push({ company: account.company_name, action: existingTask?.length ? "created SD (BLOCKED) — task already exists" : "created SD (BLOCKED) + task Antonio" })
      } else {
        // Slice 9 (REV 4.1): a To-Do board card instead of an old-style task.
        // emitActionNeeded inserts a staff message_actions card from the
        // `ra_renewal_upcoming` action_events row (next_step + default_assignee),
        // idempotent per source_ref so a daily re-run never duplicates it. The
        // card's Mark Done (TaxRenewalActions) calls fileRenewal. SD + email
        // report are unchanged.
        await emitActionNeeded({
          event: "ra_renewal_upcoming",
          account_id: account.id,
          source_ref: `ra_renewal:${sd?.id}`,
        })

        created++
        results.push({ company: account.company_name, action: "created SD + card" })
      }
    }

    logCron({
      endpoint: "/api/cron/ra-renewal-check",
      status: "success",
      duration_ms: Date.now() - startTime,
      details: { checked: accounts.length, created, skipped, blocked, results },
    })

    // Send email report if there are new renewals or blocked accounts
    if (created > 0 || blocked > 0) {
      try {
        const { gmailPost } = await import("@/lib/gmail")

        const renewalRows = results
          .filter(r => r.action === "created SD + card")
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
          <h2>🔄 RA Renewal Report — ${today.toISOString().split("T")[0]}</h2>
          <p><strong>${created}</strong> new renewals | <strong>${blocked}</strong> blocked | <strong>${skipped}</strong> skipped | <strong>${accounts.length}</strong> checked</p>
          ${renewalRows ? `<h3>✅ New renewals to do (Luca)</h3>
          <table style="border-collapse:collapse;width:100%">
            <tr style="background:#f5f5f5"><th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Company</th><th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Action</th></tr>
            ${renewalRows}
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
          <p style="margin-top:16px;color:#888;font-size:12px">Auto-generated by /api/cron/ra-renewal-check</p>
        `

        await gmailPost("/messages/send", {
          to: "support@tonydurante.us",
          subject: `🔄 RA Renewal: ${created} new${blocked ? ` + ${blocked} blocked` : ""}`,
          htmlBody: html,
        })
      } catch (emailErr) {
        // Email failure is non-blocking — log but don't fail the cron
        console.error("RA Renewal email report failed:", emailErr)
      }
    }

    return NextResponse.json({ ok: true, checked: accounts.length, created, skipped, blocked, results })

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
