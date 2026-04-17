/**
 * P2.8 — data queries and pure helpers for `/system-health`.
 *
 * Consumed by `app/(dashboard)/system-health/page.tsx`.
 * Pure helpers (cronStatusFromLog, etc.) are unit-tested; DB-touching
 * functions are thin wrappers that delegate filtering / shaping to the
 * pure helpers so the DB code itself stays trivial.
 *
 * Plan reference: restructure-plan-final-v1 §4 lines 578-586 (the 7 widgets).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { SCHEDULED_CRONS, expectedIntervalMs } from "@/lib/cron-coverage"

export type TrafficLight = "green" | "yellow" | "red" | "unknown"

export interface CronStatusRow {
  endpoint: string
  schedule: string
  lastRunAt: string | null
  lastStatus: "success" | "error" | null
  lastDurationMs: number | null
  lastError: string | null
  status: TrafficLight
  expectedIntervalMs: number | null
  ageMs: number | null
}

/**
 * Pure traffic-light resolver.
 *
 * Rules (plan §4 L580 "green/yellow/red status"):
 *  - no last run in window OR last run age > 2× interval → red (stale)
 *  - last run status = "error" → red
 *  - last run age > 1× interval but ≤ 2× interval → yellow (late)
 *  - last run success AND within interval → green
 *  - unknown schedule (expectedIntervalMs === null) → unknown
 */
export function cronStatusFromLog(
  lastRunAt: string | null,
  lastStatus: "success" | "error" | null,
  intervalMs: number | null,
  nowMs: number = Date.now(),
): TrafficLight {
  if (intervalMs === null) return "unknown"
  if (!lastRunAt) return "red"
  const age = nowMs - new Date(lastRunAt).getTime()
  if (age > 2 * intervalMs) return "red"
  if (lastStatus === "error") return "red"
  if (age > intervalMs) return "yellow"
  return "green"
}

/**
 * Fetches the latest cron_log entry per registered cron endpoint, then
 * resolves a traffic-light per row.
 *
 * Query: one round-trip that pulls all rows in the last 8 days (covers the
 * slowest registered cron — weekly raw-sql-weekly-report). Bucketed client-
 * side to avoid 21 round-trips.
 */
export async function getCronStatusList(
  nowMs: number = Date.now(),
): Promise<CronStatusRow[]> {
  const sinceIso = new Date(nowMs - 8 * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabaseAdmin
    .from("cron_log")
    .select("endpoint, status, executed_at, duration_ms, error_message")
    .gte("executed_at", sinceIso)
    .order("executed_at", { ascending: false })

  if (error) throw new Error(`cron_log query failed: ${error.message}`)

  const latestByEndpoint = new Map<
    string,
    {
      status: string
      executed_at: string
      duration_ms: number | null
      error_message: string | null
    }
  >()
  for (const row of data ?? []) {
    if (!latestByEndpoint.has(row.endpoint)) {
      latestByEndpoint.set(row.endpoint, row)
    }
  }

  const rows: CronStatusRow[] = Object.entries(SCHEDULED_CRONS).map(
    ([endpoint, schedule]) => {
      const latest = latestByEndpoint.get(endpoint)
      const intervalMs = expectedIntervalMs(schedule)
      const lastRunAt = latest?.executed_at ?? null
      const lastStatus =
        latest?.status === "success" || latest?.status === "error"
          ? (latest.status as "success" | "error")
          : null
      const status = cronStatusFromLog(lastRunAt, lastStatus, intervalMs, nowMs)
      return {
        endpoint,
        schedule,
        lastRunAt,
        lastStatus,
        lastDurationMs: latest?.duration_ms ?? null,
        lastError: latest?.error_message ?? null,
        status,
        expectedIntervalMs: intervalMs,
        ageMs: lastRunAt ? nowMs - new Date(lastRunAt).getTime() : null,
      }
    },
  )

  rows.sort((a, b) => {
    const order: Record<TrafficLight, number> = {
      red: 0,
      yellow: 1,
      unknown: 2,
      green: 3,
    }
    if (order[a.status] !== order[b.status])
      return order[a.status] - order[b.status]
    return a.endpoint.localeCompare(b.endpoint)
  })

  return rows
}

export interface AuditFinding {
  severity: "P0" | "P1" | "P2"
  check_name: string
  table_name: string
  records_affected: number
  description: string
  sample_ids: string | null
}

export interface AuditSnapshot {
  executedAt: string | null
  p0: number
  p1: number
  p2: number
  totalFindings: number
  totalAffected: number
  findings: AuditFinding[]
  cronStatus: "success" | "error" | null
}

/**
 * Plan §4 L581: "Latest audit-health-check findings (P0/P1/P2 with drill-down)".
 * Sources from cron_log (the audit cron writes its findings into details).
 */
export async function getLatestAuditFindings(): Promise<AuditSnapshot> {
  const { data, error } = await supabaseAdmin
    .from("cron_log")
    .select("status, executed_at, details")
    .eq("endpoint", "/api/cron/audit-health-check")
    .order("executed_at", { ascending: false })
    .limit(1)

  if (error) throw new Error(`audit cron_log query failed: ${error.message}`)

  const row = data?.[0]
  if (!row) {
    return {
      executedAt: null,
      p0: 0,
      p1: 0,
      p2: 0,
      totalFindings: 0,
      totalAffected: 0,
      findings: [],
      cronStatus: null,
    }
  }

  const details = (row.details ?? {}) as {
    p0?: number
    p1?: number
    p2?: number
    total_findings?: number
    total_affected?: number
    findings?: AuditFinding[]
  }

  return {
    executedAt: row.executed_at,
    p0: details.p0 ?? 0,
    p1: details.p1 ?? 0,
    p2: details.p2 ?? 0,
    totalFindings: details.total_findings ?? 0,
    totalAffected: details.total_affected ?? 0,
    findings: Array.isArray(details.findings) ? details.findings : [],
    cronStatus:
      row.status === "success" || row.status === "error" ? row.status : null,
  }
}

export interface StuckClientsSnapshot {
  nullStageByType: { service_type: string; count: number }[]
  stuckActivations: number
}

/**
 * Plan §4 L583: "Current stuck-client counts by service type."
 *
 * Two signals rolled up:
 *   1. Active service_deliveries with stage IS NULL grouped by service_type
 *      (matches audit CHECK 28 — the primary "stuck" metric).
 *   2. pending_activations stuck at payment_confirmed > 7 days (CHECK 27,
 *      not grouped because pending_activations does not carry service_type
 *      in a stable way across the table's history).
 */
export async function getStuckClientsByServiceType(
  nowMs: number = Date.now(),
): Promise<StuckClientsSnapshot> {
  const { data: stuckSDs, error: sdErr } = await supabaseAdmin
    .from("service_deliveries")
    .select("service_type")
    .eq("status", "active")
    .is("stage", null)

  if (sdErr) throw new Error(`stuck SD query failed: ${sdErr.message}`)

  const counts = new Map<string, number>()
  for (const row of stuckSDs ?? []) {
    const key = row.service_type ?? "(unknown)"
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const nullStageByType = Array.from(counts.entries())
    .map(([service_type, count]) => ({ service_type, count }))
    .sort((a, b) => b.count - a.count)

  const sevenDaysAgoIso = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { count: stuckActivationsCount, error: paErr } = await supabaseAdmin
    .from("pending_activations")
    .select("id", { count: "exact", head: true })
    .eq("status", "payment_confirmed")
    .lt("updated_at", sevenDaysAgoIso)

  if (paErr) throw new Error(`pending_activations query failed: ${paErr.message}`)

  return {
    nullStageByType,
    stuckActivations: stuckActivationsCount ?? 0,
  }
}

export interface WorkLockRow {
  id: string
  locked_by: string
  file_path: string
  reason: string | null
  claimed_at: string
  ageMs: number
}

export async function getActiveWorkLocks(
  nowMs: number = Date.now(),
): Promise<WorkLockRow[]> {
  const { data, error } = await supabaseAdmin
    .from("work_locks")
    .select("id, locked_by, file_path, reason, claimed_at")
    .is("released_at", null)
    .order("claimed_at", { ascending: false })

  if (error) throw new Error(`work_locks query failed: ${error.message}`)

  return (data ?? []).map((row) => ({
    id: row.id,
    locked_by: row.locked_by,
    file_path: row.file_path,
    reason: row.reason,
    claimed_at: row.claimed_at,
    ageMs: nowMs - new Date(row.claimed_at).getTime(),
  }))
}

export interface SmokeCheck {
  check: string
  url: string
  status: string
  expected: string
  result: "pass" | "fail" | string
  reason?: string
}

export interface SmokeResultRow {
  id: string
  commit_sha: string
  workflow_run_url: string | null
  any_failed: boolean
  failure_count: number
  checks: SmokeCheck[]
  checked_at: string
}

/**
 * Plan §4 L585 + L586: "Last deploy + CI status" + "Recent deploy_smoke_results".
 * The single query backs both widgets (latest row + history).
 */
export async function getSmokeResults(limit: number = 10): Promise<SmokeResultRow[]> {
  const { data, error } = await supabaseAdmin
    .from("deploy_smoke_results")
    .select("id, commit_sha, workflow_run_url, any_failed, failure_count, checks, checked_at")
    .order("checked_at", { ascending: false })
    .limit(limit)

  if (error) throw new Error(`deploy_smoke_results query failed: ${error.message}`)

  return (data ?? []).map((row) => ({
    id: row.id,
    commit_sha: row.commit_sha,
    workflow_run_url: row.workflow_run_url,
    any_failed: row.any_failed,
    failure_count: row.failure_count,
    checks: Array.isArray(row.checks) ? (row.checks as unknown as SmokeCheck[]) : [],
    checked_at: row.checked_at,
  }))
}

export interface SentryStatus {
  available: false
  reason: string
  dashboardUrl: string | null
}

/**
 * Plan §4 L582: "Last 10 Sentry errors from dbWrite".
 *
 * Sentry API access is explicitly NOT wired today per plan §10.3 and §14.2.
 * This widget therefore returns a structured placeholder with a link to the
 * Sentry project when the DSN is configured. Wiring the Sentry REST API is
 * a follow-up project, not part of P2.8 scope.
 */
export function getSentryStatus(): SentryStatus {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN ?? null
  let dashboardUrl: string | null = null
  if (dsn) {
    const match = dsn.match(/^https?:\/\/[^@]+@([^/]+)\/(\d+)/)
    if (match) {
      const host = match[1].replace(/^o\d+\./, "")
      dashboardUrl = `https://${host}/issues/?query=dbWrite%5B`
    }
  }
  return {
    available: false,
    reason:
      "Sentry API not wired (plan §10.3, §14.2). dbWrite errors are captured to Sentry — view in the Sentry dashboard.",
    dashboardUrl,
  }
}

export function formatRelative(ageMs: number | null, nowMs: number = Date.now()): string {
  void nowMs
  if (ageMs === null) return "never"
  const sec = Math.round(ageMs / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 48) return `${hr}h ago`
  const day = Math.round(hr / 24)
  return `${day}d ago`
}
