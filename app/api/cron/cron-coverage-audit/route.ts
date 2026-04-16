/**
 * Cron: cron-coverage-audit (P2.10 — plan §4 line 590)
 * Schedule: daily 09:30 UTC (after audit-health-check at 07:00 has had time to run)
 *
 * Two jobs:
 *   (A) Stale-cron detector — for every scheduled cron in SCHEDULED_CRONS,
 *       check cron_log for its last run. If (now - last_run) > 2× expected
 *       interval, open/update a dev_task. This is the plan directive
 *       "raises a TODO when any cron has not run within 2× its schedule
 *       interval".
 *
 *   (B) Zero-findings streak meta-monitor — queries the last 30 days of
 *       audit-health-check runs and counts DAYS with only zero-findings
 *       results. If the streak >= 5 distinct days, open/update a dev_task.
 *       This is the countermeasure for the Phase 0 failure mode documented
 *       in plan line 47: "the cron has been running for 5 consecutive days
 *       reporting findings: [] every time — while 350+ real data problems
 *       exist in the database unreported."
 *
 * Both findings are written as dev_tasks and DEDUPED by title prefix +
 * date (same pattern as /api/cron/raw-sql-weekly-report, to avoid the
 * audit-health-check duplicate-task bug documented as known issue #10 in
 * session-context).
 */

export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"
import {
  SCHEDULED_CRONS,
  expectedIntervalMs,
  isStale,
  zeroFindingsStreakDays,
  type AuditRunRow,
} from "@/lib/cron-coverage"

interface StaleCron {
  endpoint: string
  cronExpr: string
  expectedMs: number | null
  lastRunIso: string | null
  ageMs: number | null
}

const ZERO_FINDINGS_ALERT_THRESHOLD_DAYS = 5

export async function GET(req: NextRequest) {
  const startMs = Date.now()
  try {
    const authHeader = req.headers.get("authorization")
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // ─── (A) Stale-cron detector ──────────────────────────────────
    // One query: last run per endpoint for every endpoint in SCHEDULED_CRONS.
    const endpoints = Object.keys(SCHEDULED_CRONS)
    const { data: lastRunRows, error: lastRunErr } = await supabaseAdmin
      .from("cron_log")
      .select("endpoint, executed_at")
      .in("endpoint", endpoints)
      .gte("executed_at", new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString())
      .order("executed_at", { ascending: false })

    if (lastRunErr) throw lastRunErr

    const lastRunByEndpoint = new Map<string, string>()
    for (const row of (lastRunRows ?? []) as Array<{ endpoint: string; executed_at: string }>) {
      if (!lastRunByEndpoint.has(row.endpoint)) {
        lastRunByEndpoint.set(row.endpoint, row.executed_at)
      }
    }

    const now = Date.now()
    const stale: StaleCron[] = []
    for (const [endpoint, cronExpr] of Object.entries(SCHEDULED_CRONS)) {
      const lastRunIso = lastRunByEndpoint.get(endpoint) ?? null
      if (isStale(lastRunIso, cronExpr, now)) {
        stale.push({
          endpoint,
          cronExpr,
          expectedMs: expectedIntervalMs(cronExpr),
          lastRunIso,
          ageMs: lastRunIso ? now - new Date(lastRunIso).getTime() : null,
        })
      }
    }

    // ─── (B) Zero-findings streak meta-monitor ────────────────────
    const { data: auditRows, error: auditErr } = await supabaseAdmin
      .from("cron_log")
      .select("status, executed_at, details")
      .eq("endpoint", "/api/cron/audit-health-check")
      .gte("executed_at", new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString())
      .order("executed_at", { ascending: false })

    if (auditErr) throw auditErr

    const streakDays = zeroFindingsStreakDays((auditRows ?? []) as AuditRunRow[])
    const auditAlert = streakDays >= ZERO_FINDINGS_ALERT_THRESHOLD_DAYS

    // ─── Upsert dev_tasks (dedupe by title prefix) ────────────────
    const today = new Date().toISOString().split("T")[0]

    // A) stale crons — one task per run, listing all stale endpoints
    if (stale.length > 0) {
      const titlePrefix = `[AUTO] Cron coverage: ${stale.length} stale cron`
      const title = `[AUTO] Cron coverage: ${stale.length} stale cron${stale.length === 1 ? "" : "s"} — ${today}`
      const lines = stale.map(s =>
        `  - ${s.endpoint} (schedule: ${s.cronExpr}; expected interval: ${s.expectedMs ? Math.round(s.expectedMs / 60000) + "m" : "?"}; ` +
        (s.lastRunIso ? `last run: ${s.lastRunIso} (${Math.round((s.ageMs ?? 0) / 3600_000)}h ago)` : "NEVER in 40d")
        + ")"
      ).join("\n")
      const log = [{
        date: today,
        action: "Stale cron detection",
        result:
          `Found ${stale.length} scheduled cron${stale.length === 1 ? "" : "s"} past 2× expected interval:\n${lines}\n\n` +
          `Check Vercel Cron logs (https://vercel.com/.../cron-jobs) for the stale endpoints; if Vercel shows invocations but cron_log has none, logCron is silently failing for that endpoint.`,
      }]
      await upsertDevTask(titlePrefix, title, log, "high")
    }

    // B) audit-health-check zero-findings streak
    if (auditAlert) {
      const titlePrefix = `[AUTO] Meta-monitor: audit-health-check zero findings`
      const title = `${titlePrefix} — ${streakDays} consecutive days — ${today}`
      const log = [{
        date: today,
        action: "Zero-findings streak detected",
        result:
          `The audit-health-check cron has reported zero findings for ${streakDays} consecutive calendar days. ` +
          `Plan §4 line 47 documents the exact failure mode: "the cron has been running for N consecutive days reporting findings: [] every time — while real data problems exist unreported." ` +
          `Check: (1) is AUDIT_SQL in app/api/cron/audit-health-check/route.ts still the real 39-check query? ` +
          `(2) does manual curl with CRON_SECRET return the same zero? (3) has exec_sql's parameter name drifted again?`,
      }]
      await upsertDevTask(titlePrefix, title, log, "high")
    }

    logCron({
      endpoint: "/api/cron/cron-coverage-audit",
      status: "success",
      duration_ms: Date.now() - startMs,
      details: {
        scheduled_crons: endpoints.length,
        stale_count: stale.length,
        audit_zero_findings_days: streakDays,
        audit_alert: auditAlert,
      },
    })

    return NextResponse.json({
      ok: true,
      summary: {
        scheduled_crons: endpoints.length,
        stale_count: stale.length,
        audit_zero_findings_streak_days: streakDays,
        audit_alert: auditAlert,
      },
      stale,
      elapsed_ms: Date.now() - startMs,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logCron({
      endpoint: "/api/cron/cron-coverage-audit",
      status: "error",
      duration_ms: Date.now() - startMs,
      error_message: msg,
    })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

async function upsertDevTask(
  titlePrefix: string,
  title: string,
  progressLog: Array<{ date: string; action: string; result: string }>,
  priority: "high" | "medium" | "low",
): Promise<void> {
  const { data: existing } = await supabaseAdmin
    .from("dev_tasks")
    .select("id")
    .like("title", `${titlePrefix}%`)
    .in("status", ["todo", "in_progress"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existing?.id) {
    await supabaseAdmin
      .from("dev_tasks")
      .update({
        title,
        progress_log: JSON.stringify(progressLog),
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
  } else {
    await supabaseAdmin
      .from("dev_tasks")
      .insert({
        title,
        status: "todo",
        priority,
        type: "infra",
        progress_log: JSON.stringify(progressLog),
      })
  }
}
