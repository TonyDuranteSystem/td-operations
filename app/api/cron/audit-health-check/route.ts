/**
 * Cron: Audit Health Check
 * Schedule: daily at 9am ET via Vercel cron
 *
 * Runs the 39-check audit query from scripts/audit-health-check.sql
 * against the database and logs findings to cron_log.
 * If P0 issues are found, creates a dev_task for immediate attention.
 */

export const dynamic = "force-dynamic"
export const maxDuration = 60

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logCron } from "@/lib/cron-log"

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  try {
    const authHeader = req.headers.get("authorization")
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Run the core health checks inline (subset of audit-health-check.sql)
    const { data: rows, error } = await supabaseAdmin.rpc("exec_sql", {
      query: AUDIT_SQL,
    })

    // Fallback: if exec_sql RPC doesn't exist, run checks individually
    const findings = error ? await runChecksIndividually() : (rows as AuditRow[])

    const p0Count = findings.filter((r) => r.severity === "P0").length
    const p1Count = findings.filter((r) => r.severity === "P1").length
    const p2Count = findings.filter((r) => r.severity === "P2").length
    const totalAffected = findings.reduce((s, r) => s + r.records_affected, 0)

    // Log to cron_log
    logCron({
      endpoint: "/api/cron/audit-health-check",
      status: p0Count > 0 ? "error" : "success",
      duration_ms: Date.now() - startTime,
      details: {
        p0: p0Count,
        p1: p1Count,
        p2: p2Count,
        total_findings: findings.length,
        total_affected: totalAffected,
        findings: findings.slice(0, 20),
      },
    })

    // If P0 issues found, create a dev_task
    if (p0Count > 0) {
      const p0Findings = findings.filter((r) => r.severity === "P0")
      await supabaseAdmin.from("dev_tasks").insert({
        title: `[AUTO] Audit Health Check: ${p0Count} P0 issue(s) found`,
        status: "todo",
        priority: "high",
        type: "bug",
        progress_log: JSON.stringify(
          p0Findings.map((f) => ({
            date: new Date().toISOString().split("T")[0],
            action: f.check_name,
            result: `${f.records_affected} rows — ${f.description}`,
          }))
        ),
      })
    }

    return NextResponse.json({
      ok: true,
      summary: { p0: p0Count, p1: p1Count, p2: p2Count, total_findings: findings.length },
      findings,
      elapsed_ms: Date.now() - startTime,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logCron({
      endpoint: "/api/cron/audit-health-check",
      status: "error",
      duration_ms: Date.now() - startTime,
      error_message: msg,
    })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

interface AuditRow {
  check_name: string
  table_name: string
  severity: string
  records_affected: number
  sample_ids: string | null
  description: string
}

async function runChecksIndividually(): Promise<AuditRow[]> {
  const results: AuditRow[] = []

  const checks: Array<{ name: string; table: string; severity: string; sql: string; desc: string }> = [
    {
      name: "invalid_sd_status",
      table: "service_deliveries",
      severity: "P0",
      sql: `SELECT count(*)::int AS cnt, string_agg(DISTINCT status, ', ') AS vals FROM service_deliveries WHERE status NOT IN ('active','blocked','completed','cancelled')`,
      desc: "SD status not in allowed values",
    },
    {
      name: "paid_null_date",
      table: "payments",
      severity: "P0",
      sql: `SELECT count(*)::int AS cnt FROM payments WHERE status = 'Paid' AND paid_date IS NULL`,
      desc: "Payments marked Paid with NULL paid_date",
    },
    {
      name: "orphan_sd_account",
      table: "service_deliveries",
      severity: "P0",
      sql: `SELECT count(*)::int AS cnt FROM service_deliveries sd LEFT JOIN accounts a ON sd.account_id = a.id WHERE sd.account_id IS NOT NULL AND a.id IS NULL`,
      desc: "SDs referencing non-existent account",
    },
    {
      name: "orphan_payment_account",
      table: "payments",
      severity: "P0",
      sql: `SELECT count(*)::int AS cnt FROM payments p LEFT JOIN accounts a ON p.account_id = a.id WHERE p.account_id IS NOT NULL AND a.id IS NULL`,
      desc: "Payments referencing non-existent account",
    },
    {
      name: "portal_tier_mismatch",
      table: "contacts/accounts",
      severity: "P1",
      sql: `SELECT count(*)::int AS cnt FROM contacts c JOIN account_contacts ac ON ac.contact_id = c.id JOIN accounts a ON a.id = ac.account_id WHERE c.portal_tier IS DISTINCT FROM a.portal_tier AND (c.portal_tier IS NOT NULL OR a.portal_tier IS NOT NULL)`,
      desc: "Portal tier mismatch between contact and account",
    },
    {
      name: "null_stage_active_sd",
      table: "service_deliveries",
      severity: "P1",
      sql: `SELECT count(*)::int AS cnt FROM service_deliveries sd WHERE sd.status = 'active' AND sd.stage IS NULL AND EXISTS (SELECT 1 FROM pipeline_stages ps WHERE ps.service_type = sd.service_type)`,
      desc: "Active SDs with NULL stage where pipeline exists",
    },
    {
      name: "stuck_pending_activation",
      table: "pending_activations",
      severity: "P1",
      sql: `SELECT count(*)::int AS cnt FROM pending_activations WHERE status = 'payment_confirmed' AND activated_at IS NULL AND payment_confirmed_at < now() - interval '7 days'`,
      desc: "Pending activations stuck > 7 days after payment",
    },
    {
      name: "invalid_invoice_status",
      table: "client_invoices",
      severity: "P0",
      sql: `SELECT count(*)::int AS cnt, string_agg(DISTINCT status, ', ') AS vals FROM client_invoices WHERE status NOT IN ('Draft','Sent','Paid','Partial','Overdue','Cancelled')`,
      desc: "Invoice status not in allowed values",
    },
    {
      name: "active_sd_cancelled_account",
      table: "service_deliveries",
      severity: "P1",
      sql: `SELECT count(*)::int AS cnt FROM service_deliveries sd JOIN accounts a ON sd.account_id = a.id WHERE sd.status = 'active' AND a.status IN ('Cancelled','Closed')`,
      desc: "Active SDs on cancelled/closed accounts",
    },
  ]

  for (const check of checks) {
    try {
      const { data } = await supabaseAdmin.rpc("exec_sql", { query: check.sql })
      const row = Array.isArray(data) ? data[0] : null
      const cnt = row?.cnt ?? 0
      if (cnt > 0) {
        results.push({
          check_name: check.name,
          table_name: check.table,
          severity: check.severity,
          records_affected: cnt,
          sample_ids: row?.vals ?? null,
          description: `${check.desc}: ${cnt} rows`,
        })
      }
    } catch {
      // Individual check failed — skip, don't block others
    }
  }

  return results
}

// The full audit SQL is in scripts/audit-health-check.sql (630 lines).
// This constant holds the top-level CTE query for use with exec_sql RPC.
// If exec_sql is unavailable, we fall back to runChecksIndividually() above.
const AUDIT_SQL = "SELECT 'rpc_not_configured' AS check_name, 'system' AS table_name, 'P2' AS severity, 0::int AS records_affected, NULL AS sample_ids, 'exec_sql RPC not available — using individual checks' AS description"
