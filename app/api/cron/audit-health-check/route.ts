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
import { gmailPost } from "@/lib/gmail"

export async function GET(req: NextRequest) {
  const startTime = Date.now()
  try {
    const authHeader = req.headers.get("authorization")
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Run the full 39-check audit SQL via exec_sql RPC.
    // Fixed 2026-04-14 P0.3: was { query: ... } which is the wrong parameter
    // name — exec_sql expects { sql_query: ... }, so the cron was silently
    // erroring and the fallback runChecksIndividually() was running instead.
    const { data: rows, error } = await supabaseAdmin.rpc("exec_sql", {
      sql_query: AUDIT_SQL,
    })

    // Fallback: if exec_sql RPC doesn't exist, run checks individually
    const findings = error ? await runChecksIndividually() : (rows as unknown as AuditRow[])

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
        type: "bugfix",
        progress_log: JSON.stringify(
          p0Findings.map((f) => ({
            date: new Date().toISOString().split("T")[0],
            action: f.check_name,
            result: `${f.records_affected} rows — ${f.description}`,
          }))
        ),
      })
    }

    // Email alert — added 2026-04-14 P0.3 step 4.
    // Fires whenever the cron finds any findings at all. Wrapped in try/catch
    // so a failed send does not break the cron response. Subject is RFC 2047
    // base64-encoded per R041.
    if (findings.length > 0) {
      try {
        const severityBadge = p0Count > 0 ? "🔴" : p1Count > 0 ? "🟠" : "🟡"
        const subject = `${severityBadge} Audit Health Check: ${findings.length} finding(s) — P0:${p0Count} P1:${p1Count} P2:${p2Count}`

        const findingRows = findings
          .slice(0, 30)
          .map((f) => {
            const color = f.severity === "P0" ? "#dc2626" : f.severity === "P1" ? "#f59e0b" : "#71717a"
            return `<tr style="border-bottom: 1px solid #e4e4e7;">
              <td style="padding: 8px; font-size: 12px; color: ${color}; font-weight: 600;">${f.severity}</td>
              <td style="padding: 8px; font-size: 12px; font-family: ui-monospace, monospace;">${f.check_name}</td>
              <td style="padding: 8px; font-size: 12px;">${f.table_name}</td>
              <td style="padding: 8px; font-size: 12px; text-align: right; font-weight: 600;">${f.records_affected}</td>
              <td style="padding: 8px; font-size: 12px; color: #52525b;">${(f.description || "").substring(0, 120)}</td>
            </tr>`
          })
          .join("")

        const html = `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 900px; margin: 0 auto; padding: 20px;">
            <h2 style="font-size: 18px; color: #18181b;">Daily Audit Health Check — ${findings.length} Finding(s)</h2>
            <p style="color: #52525b; font-size: 13px;">
              <strong style="color: #dc2626;">${p0Count} P0</strong> (data integrity) ·
              <strong style="color: #f59e0b;">${p1Count} P1</strong> (business logic) ·
              <strong style="color: #71717a;">${p2Count} P2</strong> (warnings) ·
              ${totalAffected} total rows affected
            </p>
            <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
              <thead>
                <tr style="background: #f4f4f5;">
                  <th style="padding: 8px; text-align: left; font-size: 11px; color: #71717a;">Severity</th>
                  <th style="padding: 8px; text-align: left; font-size: 11px; color: #71717a;">Check</th>
                  <th style="padding: 8px; text-align: left; font-size: 11px; color: #71717a;">Table</th>
                  <th style="padding: 8px; text-align: right; font-size: 11px; color: #71717a;">Rows</th>
                  <th style="padding: 8px; text-align: left; font-size: 11px; color: #71717a;">Description</th>
                </tr>
              </thead>
              <tbody>${findingRows}</tbody>
            </table>
            ${findings.length > 30 ? `<p style="color: #71717a; font-size: 11px; margin-top: 12px;">Showing first 30 of ${findings.length} findings. Full list in cron_log.</p>` : ""}
            <p style="color: #a1a1aa; font-size: 11px; margin-top: 24px;">
              Source: /api/cron/audit-health-check · ${new Date().toISOString()}
            </p>
          </div>
        `

        const mimeMessage = [
          "From: Tony Durante LLC <support@tonydurante.us>",
          "To: support@tonydurante.us",
          `Subject: =?utf-8?B?${Buffer.from(subject).toString("base64")}?=`,
          "MIME-Version: 1.0",
          "Content-Type: text/html; charset=UTF-8",
          "",
          html,
        ].join("\r\n")

        const raw = Buffer.from(mimeMessage).toString("base64url")
        await gmailPost("/messages/send", { raw })
      } catch (emailErr) {
        console.error("[audit-health-check] email alert failed:", emailErr)
        // Do not fail the cron response just because email alert failed.
      }
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
      // Fixed 2026-04-14 P0.3: was { query: ... } — same parameter-name bug
      // as the main path at line 27-28. Fallback was also silently returning
      // empty rows from exec_sql.
      const { data } = await supabaseAdmin.rpc("exec_sql", { sql_query: check.sql })
      const row = Array.isArray(data) ? data[0] as Record<string, unknown> | null : null
      const cnt = (row?.cnt as number) ?? 0
      if (cnt > 0) {
        results.push({
          check_name: check.name,
          table_name: check.table,
          severity: check.severity,
          records_affected: cnt,
          sample_ids: (row?.vals as string) ?? null,
          description: `${check.desc}: ${cnt} rows`,
        })
      }
    } catch {
      // Individual check failed — skip, don't block others
    }
  }

  return results
}

// =============================================================================
// AUDIT_SQL — inlined 39-check audit query
// =============================================================================
// Inlined 2026-04-14 P0.3 (D2 = α per Antonio) to make the daily audit cron
// actually run. Before this, AUDIT_SQL was a 1-row stub that emitted a fake
// "rpc_not_configured" finding, and the cron reported "0 findings" for 5
// consecutive days while 350+ real problems existed in the database.
//
// SOURCE OF TRUTH: scripts/audit-health-check.sql (kept as the canonical copy
// so it can also be run manually). KEEP THE TWO IN SYNC — if you edit one,
// edit the other. This duplication is a deliberate Phase 0 containment
// choice (option α); a Phase 1+ refactor may collapse it.
//
// The trailing semicolon from the .sql file is deliberately stripped — the
// exec_sql RPC rejects queries with trailing semicolons (syntax error at ";").
//
// CHECKS 29, 30, 31 were rewritten in P0.2 on 2026-04-14 to match the current
// schema (accounts↔contacts is via account_contacts junction; auth↔contacts
// is via auth.users.raw_app_meta_data->>'contact_id'). See the .sql file for
// the explanatory comments.
const AUDIT_SQL = `WITH audit_results AS (

  -- =========================================================================
  -- SECTION 1: STATUS VALUE CHECKS
  -- =========================================================================

  -- CHECK 1: service_deliveries.status
  SELECT
    'invalid_sd_status'                     AS check_name,
    'service_deliveries'                    AS table_name,
    'P0'                                    AS severity,
    COUNT(*)::int                           AS records_affected,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200) AS sample_ids,
    'status values not in (active, blocked, completed, cancelled): found ' ||
      STRING_AGG(DISTINCT status, ', ')     AS description
  FROM service_deliveries
  WHERE status NOT IN ('active', 'blocked', 'completed', 'cancelled')

  UNION ALL

  -- CHECK 2: service_deliveries.service_type
  SELECT
    'invalid_sd_service_type',
    'service_deliveries',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(sd.id::text, ', ' ORDER BY sd.created_at DESC), 200),
    'service_type values not matching any pipeline_stages.service_type or known types: found ' ||
      STRING_AGG(DISTINCT sd.service_type, ', ')
  FROM service_deliveries sd
  WHERE sd.service_type IS NOT NULL
    AND sd.service_type NOT IN (
      'Company Formation', 'Client Onboarding', 'Tax Return', 'State RA Renewal',
      'CMRA', 'CMRA Mailing Address', 'Shipping', 'Public Notary',
      'Banking Fintech', 'Banking Physical', 'ITIN', 'Company Closure',
      'Client Offboarding', 'State Annual Report', 'EIN', 'EIN Application',
      'Support', 'Billing Annual Renewal', 'Annual Renewal'
    )

  UNION ALL

  -- CHECK 3: offers.status
  SELECT
    'invalid_offer_status',
    'offers',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (draft, sent, viewed, signed, completed, accepted, expired): found ' ||
      STRING_AGG(DISTINCT status::text, ', ')
  FROM offers
  WHERE status::text NOT IN ('draft', 'sent', 'viewed', 'signed', 'completed', 'accepted', 'expired')

  UNION ALL

  -- CHECK 4: lease_agreements.status
  SELECT
    'invalid_lease_status',
    'lease_agreements',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (draft, sent, viewed, signed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status::text, ', '), 'N/A')
  FROM lease_agreements
  WHERE status::text NOT IN ('draft', 'sent', 'viewed', 'signed')

  UNION ALL

  -- CHECK 5: oa_agreements.status
  SELECT
    'invalid_oa_status',
    'oa_agreements',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (draft, sent, viewed, signed, partially_signed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM oa_agreements
  WHERE status NOT IN ('draft', 'sent', 'viewed', 'signed', 'partially_signed')

  UNION ALL

  -- CHECK 6: ss4_applications.status
  SELECT
    'invalid_ss4_status',
    'ss4_applications',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (draft, awaiting_signature, signed, submitted, done, fax_failed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM ss4_applications
  WHERE status NOT IN ('draft', 'awaiting_signature', 'signed', 'submitted', 'done', 'fax_failed')

  UNION ALL

  -- CHECK 7: deadlines.status
  -- The DB CHECK constraint accepts 6 values including 'Cancelled'.
  -- Keep this list aligned with the constraint (pg_constraint source of truth).
  SELECT
    'invalid_deadline_status',
    'deadlines',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (Pending, Completed, Filed, Not Started, Overdue, Cancelled): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM deadlines
  WHERE status NOT IN ('Pending', 'Completed', 'Filed', 'Not Started', 'Overdue', 'Cancelled')

  UNION ALL

  -- CHECK 8: documents.status
  SELECT
    'invalid_document_status',
    'documents',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (classified, unclassified, error, pending, processed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM documents
  WHERE status NOT IN ('classified', 'unclassified', 'error', 'pending', 'processed')

  UNION ALL

  -- CHECK 9: client_invoices.status
  SELECT
    'invalid_client_invoice_status',
    'client_invoices',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (Draft, Sent, Paid, Partial, Overdue, Cancelled): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM client_invoices
  WHERE status NOT IN ('Draft', 'Sent', 'Paid', 'Partial', 'Overdue', 'Cancelled')

  UNION ALL

  -- CHECK 10: client_expenses.status
  SELECT
    'invalid_client_expense_status',
    'client_expenses',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (Pending, Paid, Overdue, Cancelled): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM client_expenses
  WHERE status NOT IN ('Pending', 'Paid', 'Overdue', 'Cancelled')

  UNION ALL

  -- CHECK 11: banking_submissions.status
  SELECT
    'invalid_banking_sub_status',
    'banking_submissions',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (pending, sent, opened, completed, reviewed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM banking_submissions
  WHERE status NOT IN ('pending', 'sent', 'opened', 'completed', 'reviewed')

  UNION ALL

  -- CHECK 12: formation_submissions.status
  SELECT
    'invalid_formation_sub_status',
    'formation_submissions',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (pending, sent, opened, completed, reviewed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM formation_submissions
  WHERE status NOT IN ('pending', 'sent', 'opened', 'completed', 'reviewed')

  UNION ALL

  -- CHECK 13: onboarding_submissions.status
  SELECT
    'invalid_onboarding_sub_status',
    'onboarding_submissions',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (pending, sent, opened, completed, reviewed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM onboarding_submissions
  WHERE status NOT IN ('pending', 'sent', 'opened', 'completed', 'reviewed')

  UNION ALL

  -- CHECK 14: tax_return_submissions.status
  SELECT
    'invalid_tax_sub_status',
    'tax_return_submissions',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (pending, sent, opened, completed, reviewed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM tax_return_submissions
  WHERE status NOT IN ('pending', 'sent', 'opened', 'completed', 'reviewed')

  UNION ALL

  -- CHECK 15: itin_submissions.status
  SELECT
    'invalid_itin_sub_status',
    'itin_submissions',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (pending, sent, opened, completed, reviewed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM itin_submissions
  WHERE status NOT IN ('pending', 'sent', 'opened', 'completed', 'reviewed')

  UNION ALL

  -- CHECK 16: closure_submissions.status
  SELECT
    'invalid_closure_sub_status',
    'closure_submissions',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (pending, sent, opened, completed, reviewed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM closure_submissions
  WHERE status NOT IN ('pending', 'sent', 'opened', 'completed', 'reviewed')

  UNION ALL

  -- CHECK 17: wizard_progress.status
  SELECT
    'invalid_wizard_status',
    'wizard_progress',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (in_progress, submitted, reviewed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM wizard_progress
  WHERE status NOT IN ('in_progress', 'submitted', 'reviewed')

  UNION ALL

  -- CHECK 18: pending_activations.status
  SELECT
    'invalid_activation_status',
    'pending_activations',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (awaiting_payment, payment_confirmed, activated, expired, cancelled): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM pending_activations
  WHERE status NOT IN ('awaiting_payment', 'payment_confirmed', 'activated', 'expired', 'cancelled')

  UNION ALL

  -- CHECK 19: referrals.status
  SELECT
    'invalid_referral_status',
    'referrals',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (pending, converted, credited, paid, cancelled): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM referrals
  WHERE status NOT IN ('pending', 'converted', 'credited', 'paid', 'cancelled')

  UNION ALL

  -- CHECK 20: signature_requests.status
  SELECT
    'invalid_sigreq_status',
    'signature_requests',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'status values not in (draft, awaiting_signature, signed): found ' ||
      COALESCE(STRING_AGG(DISTINCT status, ', '), 'N/A')
  FROM signature_requests
  WHERE status NOT IN ('draft', 'awaiting_signature', 'signed')

  UNION ALL

  -- CHECK 21: contacts.portal_tier
  SELECT
    'invalid_contact_portal_tier',
    'contacts',
    'P1',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'portal_tier values not in (lead, onboarding, active, NULL): found ' ||
      COALESCE(STRING_AGG(DISTINCT portal_tier, ', '), 'N/A')
  FROM contacts
  WHERE portal_tier IS NOT NULL
    AND portal_tier NOT IN ('lead', 'onboarding', 'active')

  UNION ALL

  -- CHECK 22: contacts.portal_role
  SELECT
    'invalid_contact_portal_role',
    'contacts',
    'P1',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'portal_role values not in (client, partner, NULL): found ' ||
      COALESCE(STRING_AGG(DISTINCT portal_role, ', '), 'N/A')
  FROM contacts
  WHERE portal_role IS NOT NULL
    AND portal_role NOT IN ('client', 'partner')

  UNION ALL

  -- CHECK 23: accounts.portal_tier
  SELECT
    'invalid_account_portal_tier',
    'accounts',
    'P1',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'portal_tier values not in (lead, onboarding, active, NULL): found ' ||
      COALESCE(STRING_AGG(DISTINCT portal_tier, ', '), 'N/A')
  FROM accounts
  WHERE portal_tier IS NOT NULL
    AND portal_tier NOT IN ('lead', 'onboarding', 'active')

  UNION ALL

  -- CHECK 24: tasks.status
  SELECT
    'invalid_task_status',
    'tasks',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'tasks with status not in expected set (To Do, In Progress, Waiting, Done, Cancelled): found ' ||
      COALESCE(STRING_AGG(DISTINCT status::text, ', '), 'N/A')
  FROM tasks
  WHERE status::text NOT IN ('To Do', 'In Progress', 'Waiting', 'Done', 'Cancelled')

  UNION ALL

  -- =========================================================================
  -- SECTION 2: BUSINESS LOGIC CHECKS
  -- =========================================================================

  -- CHECK 25: Payments marked Paid with NULL paid_date
  SELECT
    'paid_null_paid_date',
    'payments',
    'P1',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'Payments with status=Paid but paid_date is NULL'
  FROM payments
  WHERE status = 'Paid' AND paid_date IS NULL

  UNION ALL

  -- CHECK 26: Active service_deliveries on Cancelled/Closed accounts
  SELECT
    'active_sd_cancelled_account',
    'service_deliveries',
    'P1',
    COUNT(*)::int,
    LEFT(STRING_AGG(sd.id::text, ', ' ORDER BY sd.created_at DESC), 200),
    'Active SDs linked to accounts with status Cancelled or Closed'
  FROM service_deliveries sd
  JOIN accounts a ON sd.account_id = a.id
  WHERE sd.status = 'active'
    AND a.status IN ('Cancelled', 'Closed')

  UNION ALL

  -- CHECK 27: pending_activations stuck at payment_confirmed > 7 days
  SELECT
    'stuck_activations',
    'pending_activations',
    'P1',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'Activations stuck at payment_confirmed for > 7 days (oldest: ' ||
      COALESCE(MIN(updated_at)::text, MIN(created_at)::text, '?') || ')'
  FROM pending_activations
  WHERE status = 'payment_confirmed'
    AND COALESCE(updated_at, created_at) < NOW() - INTERVAL '7 days'

  UNION ALL

  -- CHECK 28: NULL stage in service_deliveries where service_type has pipeline stages
  SELECT
    'sd_null_stage',
    'service_deliveries',
    'P2',
    COUNT(*)::int,
    LEFT(STRING_AGG(sd.id::text, ', ' ORDER BY sd.created_at DESC), 200),
    'SDs with NULL stage but service_type has defined pipeline stages: ' ||
      COALESCE(STRING_AGG(DISTINCT sd.service_type, ', '), 'N/A')
  FROM service_deliveries sd
  WHERE sd.stage IS NULL
    AND sd.status = 'active'
    AND sd.service_type IN (SELECT DISTINCT service_type FROM pipeline_stages)

  UNION ALL

  -- CHECK 29: Portal tier mismatch via account_contacts junction
  -- Fixed 2026-04-14 P0.2: accounts has no direct contact_id column.
  SELECT
    'portal_tier_contact_account_mismatch',
    'contacts / accounts',
    'P1',
    COUNT(DISTINCT c.id)::int,
    LEFT(STRING_AGG(DISTINCT c.id::text, ', '), 200),
    'Contacts whose portal_tier differs from their linked account portal_tier'
  FROM contacts c
  JOIN account_contacts ac ON ac.contact_id = c.id
  JOIN accounts a ON a.id = ac.account_id
  WHERE c.portal_tier IS DISTINCT FROM a.portal_tier
    AND c.portal_tier IS NOT NULL
    AND a.portal_tier IS NOT NULL

  UNION ALL

  -- CHECK 30: Portal tier mismatch via auth.users.raw_app_meta_data
  -- Fixed 2026-04-14 P0.2: was c.auth_uid (column does not exist) and
  -- raw_user_meta_data (wrong JSONB column).
  SELECT
    'portal_tier_contact_auth_mismatch',
    'contacts / auth.users',
    'P1',
    COUNT(*)::int,
    LEFT(STRING_AGG(c.id::text, ', '), 200),
    'Contacts whose portal_tier differs from auth.users app_metadata portal_tier'
  FROM contacts c
  JOIN auth.users u ON (u.raw_app_meta_data->>'contact_id')::uuid = c.id
  WHERE c.portal_tier IS DISTINCT FROM (u.raw_app_meta_data->>'portal_tier')
    AND c.portal_tier IS NOT NULL
    AND (u.raw_app_meta_data->>'portal_tier') IS NOT NULL

  UNION ALL

  -- CHECK 31: Client-role auth users with no matching contact
  -- Fixed 2026-04-14 P0.2: linkage is raw_app_meta_data->>'contact_id',
  -- and narrowed to role=client so internal staff aren't flagged.
  SELECT
    'orphan_auth_users',
    'auth.users',
    'P1',
    COUNT(*)::int,
    LEFT(STRING_AGG(u.id::text, ', '), 200),
    'auth.users with role=client but no matching contact via app_metadata.contact_id'
  FROM auth.users u
  WHERE (u.raw_app_meta_data->>'role') = 'client'
    AND NOT EXISTS (
      SELECT 1 FROM contacts c
      WHERE (u.raw_app_meta_data->>'contact_id') IS NOT NULL
        AND c.id = (u.raw_app_meta_data->>'contact_id')::uuid
    )

  UNION ALL

  -- CHECK 32: SD service_type not in pipeline_stages
  SELECT
    'sd_service_type_no_pipeline',
    'service_deliveries',
    'P2',
    COUNT(*)::int,
    LEFT(STRING_AGG(sd.id::text, ', ' ORDER BY sd.created_at DESC), 200),
    'SDs with service_type not matching any pipeline_stages.service_type: ' ||
      COALESCE(STRING_AGG(DISTINCT sd.service_type, ', '), 'N/A')
  FROM service_deliveries sd
  WHERE sd.service_type IS NOT NULL
    AND sd.service_type NOT IN (SELECT DISTINCT service_type FROM pipeline_stages)

  UNION ALL

  -- CHECK 33: SD stage not matching pipeline_stages for their service_type
  SELECT
    'sd_stage_invalid_for_type',
    'service_deliveries',
    'P1',
    COUNT(*)::int,
    LEFT(STRING_AGG(sd.id::text, ', ' ORDER BY sd.created_at DESC), 200),
    'SDs with stage not valid for their service_type per pipeline_stages'
  FROM service_deliveries sd
  WHERE sd.stage IS NOT NULL
    AND sd.service_type IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM pipeline_stages ps
      WHERE ps.service_type = sd.service_type
        AND ps.stage_name = sd.stage
    )

  UNION ALL

  -- CHECK 34: Active accounts with zero service deliveries
  SELECT
    'active_account_no_sds',
    'accounts',
    'P2',
    COUNT(*)::int,
    LEFT(STRING_AGG(a.id::text, ', '), 200),
    'Active accounts with zero service deliveries'
  FROM accounts a
  LEFT JOIN service_deliveries sd ON sd.account_id = a.id
  WHERE a.status = 'Active'
  GROUP BY a.id
  HAVING COUNT(sd.id) = 0

  UNION ALL

  -- CHECK 35: QB sync pending for > 7 days
  SELECT
    'qb_sync_stale',
    'payments',
    'P2',
    COUNT(*)::int,
    LEFT(STRING_AGG(id::text, ', ' ORDER BY created_at DESC), 200),
    'Payments with qb_sync_status=pending for > 7 days'
  FROM payments
  WHERE qb_sync_status = 'pending'
    AND updated_at < NOW() - INTERVAL '7 days'

  UNION ALL

  -- =========================================================================
  -- SECTION 3: ORPHAN CHECKS
  -- =========================================================================

  -- CHECK 36: SDs with non-existent account_id
  SELECT
    'orphan_sd_account',
    'service_deliveries',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(sd.id::text, ', ' ORDER BY sd.created_at DESC), 200),
    'SDs referencing account_id that does not exist in accounts'
  FROM service_deliveries sd
  LEFT JOIN accounts a ON sd.account_id = a.id
  WHERE sd.account_id IS NOT NULL
    AND a.id IS NULL

  UNION ALL

  -- CHECK 37: SDs with non-existent contact_id
  SELECT
    'orphan_sd_contact',
    'service_deliveries',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(sd.id::text, ', ' ORDER BY sd.created_at DESC), 200),
    'SDs referencing contact_id that does not exist in contacts'
  FROM service_deliveries sd
  LEFT JOIN contacts c ON sd.contact_id = c.id
  WHERE sd.contact_id IS NOT NULL
    AND c.id IS NULL

  UNION ALL

  -- CHECK 38: Payments with non-existent account_id
  SELECT
    'orphan_payment_account',
    'payments',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(p.id::text, ', ' ORDER BY p.created_at DESC), 200),
    'Payments referencing account_id that does not exist in accounts'
  FROM payments p
  LEFT JOIN accounts a ON p.account_id = a.id
  WHERE p.account_id IS NOT NULL
    AND a.id IS NULL

  UNION ALL

  -- CHECK 39: Documents with non-existent account_id
  SELECT
    'orphan_document_account',
    'documents',
    'P0',
    COUNT(*)::int,
    LEFT(STRING_AGG(d.id::text, ', ' ORDER BY d.created_at DESC), 200),
    'Documents referencing account_id that does not exist in accounts'
  FROM documents d
  LEFT JOIN accounts a ON d.account_id = a.id
  WHERE d.account_id IS NOT NULL
    AND a.id IS NULL

)

-- =========================================================================
-- FINAL OUTPUT — only rows with at least one finding
-- =========================================================================
SELECT
  check_name,
  table_name,
  severity,
  records_affected,
  sample_ids,
  description
FROM audit_results
WHERE records_affected > 0
ORDER BY
  CASE severity WHEN 'P0' THEN 1 WHEN 'P1' THEN 2 WHEN 'P2' THEN 3 END,
  records_affected DESC`
