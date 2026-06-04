/**
 * Hermes instance health — pure staleness helpers (Phase A).
 *
 * The route that uses these lives at app/api/cron/hermes-health/route.ts. Kept
 * pure + DB-free so the staleness logic is unit-testable without a Postgres
 * round-trip (same pattern as lib/cron-coverage.ts).
 *
 * A Hermes instance writes a heartbeat (hermes_instances.last_heartbeat) while
 * it's online. If the heartbeat goes stale, the instance is presumed offline.
 */

/** Default: a heartbeat older than 15 min means the instance is presumed down. */
export const STALE_HEARTBEAT_MS = 15 * 60 * 1000

export interface HermesInstanceRow {
  instance_id: string
  last_heartbeat: string | null
  status: string
}

/**
 * True if a heartbeat is older than the staleness threshold. A null/absent
 * heartbeat is treated as stale (we cannot confirm the instance is alive).
 */
export function isInstanceStale(
  lastHeartbeatIso: string | null,
  nowMs: number,
  thresholdMs: number = STALE_HEARTBEAT_MS,
): boolean {
  if (!lastHeartbeatIso) return true
  const t = new Date(lastHeartbeatIso).getTime()
  if (Number.isNaN(t)) return true // unparseable timestamp → cannot confirm alive
  return nowMs - t > thresholdMs
}

/**
 * From a set of instance rows, return those that are NOT already offline but
 * whose heartbeat is stale — i.e. the rows the health monitor should flip to
 * 'offline'. Rows already 'offline' are left alone (no redundant writes).
 */
export function selectStaleOnline(
  rows: HermesInstanceRow[],
  nowMs: number,
  thresholdMs: number = STALE_HEARTBEAT_MS,
): HermesInstanceRow[] {
  return rows.filter(
    (r) => r.status !== "offline" && isInstanceStale(r.last_heartbeat, nowMs, thresholdMs),
  )
}
