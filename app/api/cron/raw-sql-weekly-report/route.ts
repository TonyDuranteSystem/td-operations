/**
 * Cron: Raw SQL weekly report (P2.3)
 * Schedule: Monday 08:00 ET via Vercel cron
 *
 * Plan directive §4 P2.3 (line 552): "Weekly report: action_log writes by
 * table + session, surfaced as a dev_task."
 *
 * Aggregates the past 7 days of action_type='execute_sql' mutations by
 * table_name + actor and opens (or updates) a single dev_task for the
 * current week. Runs alongside the other weekly crons; auth via
 * CRON_SECRET Bearer like audit-health-check.
 *
 * Why a single dev_task per week: follows the pattern at
 * app/api/cron/audit-health-check/route.ts:59-74 (though that one inserts
 * a new row per run — see "known issue" item 10 in session-context). We
 * dedupe by title prefix so re-runs update the existing row.
 */

export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"

interface Row {
  table_name: string | null
  actor: string | null
  verb: string | null
  n: number
  with_reason: number
  without_reason: number
}

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  try {
    const authHeader = req.headers.get("authorization")
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // ─── Query: writes by table + actor + verb, last 7 days ─────
    const aggSQL = `
      WITH writes AS (
        SELECT
          table_name,
          actor,
          CASE
            WHEN upper(details->>'query') LIKE 'INSERT%' THEN 'INSERT'
            WHEN upper(details->>'query') LIKE 'UPDATE%' THEN 'UPDATE'
            WHEN upper(details->>'query') LIKE 'DELETE%' THEN 'DELETE'
            WHEN upper(details->>'query') LIKE 'WITH%' THEN 'CTE'
            ELSE NULL
          END AS verb,
          (details->>'reason') AS reason,
          (details->>'protected_table_touched')::boolean AS protected
        FROM action_log
        WHERE action_type = 'execute_sql'
          AND created_at > now() - interval '7 days'
      )
      SELECT
        table_name,
        actor,
        verb,
        count(*)::int AS n,
        count(*) FILTER (WHERE reason IS NOT NULL AND reason <> '')::int AS with_reason,
        count(*) FILTER (
          WHERE protected = true
            AND (reason IS NULL OR reason = '')
        )::int AS without_reason
      FROM writes
      WHERE verb IS NOT NULL
      GROUP BY table_name, actor, verb
      ORDER BY n DESC
    `

    const { data, error } = await supabaseAdmin.rpc("exec_sql", {
      sql_query: aggSQL,
    })

    if (error) throw error
    const rows = (Array.isArray(data) ? (data as unknown as Row[]) : [])

    const totalWrites = rows.reduce((s, r) => s + r.n, 0)
    const missingReasons = rows.reduce((s, r) => s + r.without_reason, 0)
    const distinctTables = new Set(rows.map(r => r.table_name || "unknown")).size

    // ─── Build the dev_task body ───
    const weekLabel = new Date().toISOString().split("T")[0]
    const title = `[AUTO] Raw SQL weekly report — week of ${weekLabel} (${totalWrites} writes, ${distinctTables} tables)`

    const topRows = rows.slice(0, 25)
    const tableLines = topRows.map(r =>
      `  - ${r.table_name ?? "unknown"} / ${r.actor ?? "?"} / ${r.verb}: ${r.n}` +
      (r.without_reason > 0 ? ` ⚠️ ${r.without_reason} missing reason:` : "")
    ).join("\n")

    const bodyLog = [
      {
        date: weekLabel,
        action: "Weekly raw SQL mutations report",
        result:
          `Week-over-week: ${totalWrites} raw SQL writes across ${distinctTables} tables.\n` +
          `Missing \`reason:\` on protected-table writes: ${missingReasons}.\n\n` +
          `Top 25 (table / actor / verb: count):\n${tableLines || "  (no writes this week)"}`,
      },
    ]

    // ─── Upsert the single week-rollup dev_task (dedupe by title prefix) ───
    const titlePrefix = `[AUTO] Raw SQL weekly report — week of ${weekLabel}`
    const { data: existing } = await supabaseAdmin
      .from("dev_tasks")
      .select("id, progress_log")
      .like("title", `${titlePrefix}%`)
      .limit(1)
      .maybeSingle()

    if (existing?.id) {
      await supabaseAdmin
        .from("dev_tasks")
        .update({
          title,
          progress_log: JSON.stringify(bodyLog),
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
    } else {
      await supabaseAdmin
        .from("dev_tasks")
        .insert({
          title,
          status: "todo",
          priority: missingReasons > 0 ? "high" : "medium",
          type: "infra",
          progress_log: JSON.stringify(bodyLog),
        })
    }

    logCron({
      endpoint: "/api/cron/raw-sql-weekly-report",
      status: "success",
      duration_ms: Date.now() - startTime,
      details: {
        total_writes: totalWrites,
        distinct_tables: distinctTables,
        missing_reasons: missingReasons,
        rows_returned: rows.length,
      },
    })

    return NextResponse.json({
      ok: true,
      summary: {
        total_writes: totalWrites,
        distinct_tables: distinctTables,
        missing_reasons: missingReasons,
      },
      top: topRows,
      elapsed_ms: Date.now() - startTime,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logCron({
      endpoint: "/api/cron/raw-sql-weekly-report",
      status: "error",
      duration_ms: Date.now() - startTime,
      error_message: msg,
    })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
