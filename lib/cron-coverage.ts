/**
 * P2.10 — cron coverage helpers (pure, testable).
 *
 * The route that uses these lives at app/api/cron/cron-coverage-audit/route.ts.
 * All schedule strings come from vercel.json; keep this map in sync when a
 * cron is added/removed there.
 *
 * Why not parse vercel.json at runtime: Vercel serverless functions don't
 * ship the repo's vercel.json as a readable asset, and the schedule set
 * rarely changes — an explicit map with a completeness test is both safer
 * and more reviewable.
 */

/**
 * Canonical source-of-truth map: endpoint → cron expression from vercel.json.
 * The schedule is in standard 5-field cron syntax (Vercel-supported subset):
 *   minute hour day-of-month month day-of-week
 *
 * If you edit vercel.json, update this map and the completeness test
 * (tests/unit/cron-coverage.test.ts) will catch any drift.
 */
export const SCHEDULED_CRONS: Record<string, string> = {
  "/api/qb/refresh": "0 */6 * * *",
  "/api/sync-drive": "0 */6 * * *",
  "/api/sync-airtable": "0 */6 * * *",
  "/api/cron/check-wire-payments": "0 */6 * * *",
  "/api/cron/ra-renewal-check": "0 9 * * *",
  "/api/cron/annual-report-check": "0 9 * * *",
  "/api/cron/overdue-payments-report": "0 9 * * *",
  "/api/cron/portal-issues": "0 */1 * * *",
  "/api/cron/email-monitor": "*/5 * * * *",
  "/api/cron/annual-installments": "0 10 1 * *",
  "/api/cron/deadline-reminders": "0 8 * * *",
  "/api/cron/wizard-reminders": "17 9 * * *",
  "/api/cron/process-jobs": "*/5 * * * *",
  "/api/cron/invoice-overdue": "0 9 * * *",
  "/api/cron/faxage-ss4-confirm": "0 */2 * * *",
  "/api/cron/portal-digest": "*/5 * * * *",
  "/api/cron/plaid-sync": "0 */6 * * *",
  "/api/cron/mercury-sync": "*/15 * * * *",
  "/api/cron/portal-recurring-invoices": "0 8 * * *",
  "/api/cron/audit-health-check": "0 7 * * *",
  "/api/cron/raw-sql-weekly-report": "0 12 * * 1",
  "/api/cron/tax-reactivation": "30 10 * * *",
}

/**
 * Parse a 5-field cron expression into an approximate maximum interval
 * between consecutive runs, in milliseconds. Intentionally coarse: we only
 * need "is this cron later than 2× its expected gap" — not a precise next-
 * fire computation. Handles the subset of expressions present in vercel.json
 * (verified by a completeness test in the caller).
 *
 * Supported forms:
 *   * * * * *           → 1 minute (not used; cheapest covered case)
 *   \*\/N * * * *        → N minutes
 *   H * * * *           → hourly (H picks the minute within the hour)
 *   0 \*\/N * * *        → every N hours (at minute 0)
 *   M H * * *           → daily at H:M
 *   M H * * D           → weekly on day-of-week D
 *   M H D * *           → monthly on day-of-month D
 *
 * For anything unrecognized the function returns null — callers treat that
 * as "cannot audit, skip" rather than blindly assuming a default.
 */
export function expectedIntervalMs(cronExpr: string): number | null {
  const parts = cronExpr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [minute, hour, dom, month, dow] = parts

  const MIN = 60_000
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR

  const stepMinute = minute.match(/^\*\/(\d+)$/)
  const stepHour = hour.match(/^\*\/(\d+)$/)

  // */N * * * *  → every N minutes
  if (stepMinute && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return Number(stepMinute[1]) * MIN
  }

  // M * * * *  (minute fixed, hour any)  → hourly at that minute
  if (/^\d+$/.test(minute) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return HOUR
  }

  // 0 */N * * *  → every N hours
  if (minute === "0" && stepHour && dom === "*" && month === "*" && dow === "*") {
    return Number(stepHour[1]) * HOUR
  }

  // M H * * *  → daily
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === "*" && month === "*" && dow === "*") {
    return DAY
  }

  // M H * * D  → weekly
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === "*" && month === "*" && /^\d$/.test(dow)) {
    return 7 * DAY
  }

  // M H D * *  → monthly (approximate as 31 days so we don't falsely flag Feb runs)
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && month === "*" && dow === "*") {
    return 31 * DAY
  }

  return null
}

/**
 * A cron is "stale" if (now - lastRun) exceeds 2× its expected interval, per
 * plan §4 P2.10 line 590 ("any cron has not run within 2× its schedule
 * interval"). lastRunMs null = never ran in the window the caller queried.
 */
export function isStale(
  lastRunIso: string | null,
  cronExpr: string,
  nowMs: number = Date.now(),
): boolean {
  const interval = expectedIntervalMs(cronExpr)
  if (interval === null) return false // unknown schedule: don't flag
  if (!lastRunIso) return true
  const age = nowMs - new Date(lastRunIso).getTime()
  return age > 2 * interval
}

/**
 * Zero-findings streak detection for the audit cron (plan §4 P2.10 line 590
 * meta-monitor + Phase 0 failure mode per plan line 47).
 *
 * Takes rows from cron_log where endpoint = '/api/cron/audit-health-check',
 * ordered DESC by executed_at. Returns the run count from the most recent
 * run backward where every run was success AND had total_findings = 0.
 * Breaks on the first non-success or non-zero-findings row.
 */
export interface AuditRunRow {
  status: string
  executed_at: string
  details: Record<string, unknown> | null
}

export function zeroFindingsStreak(rows: AuditRunRow[]): number {
  let streak = 0
  for (const row of rows) {
    if (row.status !== "success") break
    const findings = row.details?.total_findings
    if (typeof findings !== "number" || findings !== 0) break
    streak++
  }
  return streak
}

/**
 * Number of DISTINCT calendar days (UTC) spanned by the leading zero-findings
 * streak. "5 days" in the plan means 5 consecutive DAYS, not 5 consecutive
 * RUNS — a cron that runs hourly can accumulate 5×24 = 120 zero runs in a
 * single day and that should not flag.
 */
export function zeroFindingsStreakDays(rows: AuditRunRow[]): number {
  const streakRows = rows.slice(0, zeroFindingsStreak(rows))
  const days = new Set<string>()
  for (const row of streakRows) {
    days.add(row.executed_at.slice(0, 10))
  }
  return days.size
}
