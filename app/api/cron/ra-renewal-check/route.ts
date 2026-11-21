export const dynamic = 'force-dynamic'

import { companiesWaitingForFinalReturn } from "@/lib/closure/closing-wait"
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
    // No early return on an empty window — the renewal-date watchdog below
    // must run daily regardless of whether any renewal is currently due.
    // A company waiting for its final tax return before it closes stays Active but must not get a renewal job (dev job 0a60f416, part C).
    const waitingToClose = await companiesWaitingForFinalReturn()
    const dueAccounts = (accounts || []).filter((a) => !waitingToClose.has(a.id))

    let created = 0
    let skipped = 0
    let blocked = 0
    const results: { company: string; action: string }[] = []

    for (const account of dueAccounts) {
      // Check if SD already exists for this account this year. Includes
      // 'blocked' — the cron itself inserts blocked SDs (payment overdue), and
      // deduping on 'active' alone created a NEW blocked SD every day the date
      // sat in the window (mirrors annual-report-check's dedup).
      const { data: existingSD } = await supabaseAdmin
        .from("service_deliveries")
        .select("id")
        .eq("account_id", account.id)
        .eq("service_type", "State RA Renewal")
        .in("status", ["active", "blocked"])
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

    // ── Renewal-status watchdog (plan 89c951a7 — ONE truth) ──────────────
    // The daily email now reports EXACTLY what the calendar's problems rail
    // shows, computed by the same status engine + proposal layer. The old
    // hand-rolled date checks judged with different exclusion rules and
    // could disagree with the rail (architect blocker, council 2026-08-06).
    const watchdog: { company: string; problem: string }[] = []
    try {
      const { loadRenewalStatuses } = await import("@/lib/operations/renewal-status-loader")
      const { proposeRenewalFixes } = await import("@/lib/operations/renewal-problem-proposals")
      const loaded = await loadRenewalStatuses(supabaseAdmin)
      for (const l of loaded) {
        for (const p of proposeRenewalFixes(l)) {
          watchdog.push({ company: p.companyName, problem: `${p.summary} — ${p.status}` })
        }
      }
    } catch (wdErr) {
      console.error("Renewal-status watchdog failed:", wdErr)
    }

    logCron({
      endpoint: "/api/cron/ra-renewal-check",
      status: "success",
      duration_ms: Date.now() - startTime,
      details: { checked: dueAccounts.length, created, skipped, blocked, watchdog_flagged: watchdog.length, watchdog, results },
    })

    // No email report (Antonio, 2026-11-21: nothing is emailed to support@ for this).
    // Everything the old email listed already lives in the CRM: a new renewal is a
    // To-Do card for Luca, a blocked one is Antonio's urgent task, and the watchdog
    // list is the calendar's problems rail (same engine) and the cron log above.

    return NextResponse.json({ ok: true, checked: dueAccounts.length, created, skipped, blocked, watchdog_flagged: watchdog.length, results })

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
