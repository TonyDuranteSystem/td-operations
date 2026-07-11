/**
 * GET /api/cron/payment-integrity-alarm — the ONE monitoring alarm we kept.
 * Daily. Catches the two things you'd never notice while working:
 *   (1) a payment/bank sync that silently stopped running, and
 *   (2) broken/orphaned records (a payment/document/SD pointing at a client
 *       that no longer exists — corruption / misattributed money).
 * If either fires, it posts ONE message into Team Chat, @-mentioning Antonio —
 * no email, no dashboard. Silent when everything's fine.
 *
 * (Replaces the deleted daily audit / cron-coverage crons — but as a direct
 * ping instead of tasks + emails nobody read.)
 */
import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { SCHEDULED_CRONS, isStale } from "@/lib/cron-coverage"
import { postTeamMessage } from "@/lib/team/post-message"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// Payment/bank sync crons — a silent stop here means money data stops flowing.
const PAYMENT_SYNCS = [
  "/api/cron/mercury-sync",
  "/api/cron/stripe-sync",
  "/api/cron/plaid-sync",
  "/api/cron/airwallex-sync",
  "/api/cron/check-wire-payments",
]

const ORPHAN_SQL = `
  SELECT 'payments with a missing client' AS kind, count(*) AS n FROM payments p WHERE p.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = p.account_id)
  UNION ALL
  SELECT 'documents with a missing client', count(*) FROM documents d WHERE d.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = d.account_id)
  UNION ALL
  SELECT 'services with a missing client', count(*) FROM service_deliveries s WHERE s.account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = s.account_id)
  UNION ALL
  SELECT 'services with a missing contact', count(*) FROM service_deliveries s WHERE s.contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = s.contact_id)
`

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const now = Date.now()
  const alarms: string[] = []

  // (1) Stale payment syncs — last run per endpoint vs its schedule.
  try {
    const { data: rows } = await supabaseAdmin
      .from("cron_log")
      .select("endpoint, executed_at")
      .in("endpoint", PAYMENT_SYNCS)
      .gte("executed_at", new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString())
      .order("executed_at", { ascending: false })

    const lastRun = new Map<string, string>()
    for (const r of (rows ?? []) as Array<{ endpoint: string; executed_at: string }>) {
      if (!lastRun.has(r.endpoint)) lastRun.set(r.endpoint, r.executed_at)
    }
    for (const endpoint of PAYMENT_SYNCS) {
      const cronExpr = SCHEDULED_CRONS[endpoint]
      if (!cronExpr) continue
      const last = lastRun.get(endpoint) ?? null
      if (isStale(last, cronExpr, now)) {
        const name = endpoint.replace("/api/cron/", "")
        const ageH = last ? Math.round((now - new Date(last).getTime()) / 3_600_000) : null
        alarms.push(`• **${name}** hasn't run ${ageH != null ? `in ~${ageH}h` : "recently"} — payment data may have stopped flowing.`)
      }
    }
  } catch {
    /* best-effort */
  }

  // (2) Orphaned / broken records — corruption you'd never see per-client.
  try {
    const { data } = await supabaseAdmin.rpc("exec_sql_readonly", { sql_query: ORPHAN_SQL })
    const rows = (Array.isArray(data) ? data : []) as Array<{ kind: string; n: number }>
    for (const r of rows) {
      if (Number(r.n) > 0) alarms.push(`• **${r.n}** ${r.kind} — a broken reference (possible misattributed money).`)
    }
  } catch {
    /* best-effort */
  }

  if (alarms.length === 0) {
    return NextResponse.json({ ok: true, alarms: 0 })
  }

  const message = `⚠️ @Antonio — system alarm (${alarms.length}):\n\n${alarms.join("\n")}\n\nThese are the silent failures the point-of-work checks can't catch. Worth a look.`

  try {
    await postTeamMessage({ channel: "td-bug", message })
  } catch (e) {
    return NextResponse.json(
      { ok: false, alarms: alarms.length, posted: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }

  return NextResponse.json({ ok: true, alarms: alarms.length, posted: true })
}
