/**
 * Pure change-detection + throttle logic for the Audit Health Check email.
 *
 * The audit cron finds the same persistent issues every run, so emailing on
 * every run is pure noise. These helpers compare the current findings against
 * the last set we emailed (stored in cron_email_state) and decide whether a new
 * email is warranted: only when a finding is NEW or has ESCALATED, and at most
 * once per 24h. No I/O here — the route owns the DB read/write.
 */

export interface AuditFindingLike {
  check_name: string
  severity: string
  records_affected: number
}

/** Per-check snapshot persisted between runs: check_name → {severity, count}. */
export type FindingSnapshot = Record<string, { severity: string; count: number }>

/** Severity rank — higher is worse. Unknown severities rank 0. */
const SEVERITY_RANK: Record<string, number> = { P0: 3, P1: 2, P2: 1 }
function rank(sev: string): number {
  return SEVERITY_RANK[sev] ?? 0
}

/** Reduce findings to the comparable snapshot shape. Last write wins on dup keys. */
export function toSnapshot(findings: AuditFindingLike[]): FindingSnapshot {
  const snap: FindingSnapshot = {}
  for (const f of findings) {
    snap[f.check_name] = { severity: f.severity, count: f.records_affected }
  }
  return snap
}

/**
 * Has this finding escalated vs its previous snapshot entry?
 * Escalated = the severity got worse, OR the row count grew "significantly":
 * up by at least 20% AND by at least 5 rows (so +1 on a count of 3 isn't noise,
 * but a jump from 10→200 is). A brand-new check (no previous entry) is NOT
 * "escalated" here — it's classified as NEW separately.
 */
export function isEscalated(
  prev: { severity: string; count: number } | undefined,
  current: { severity: string; count: number },
): boolean {
  if (!prev) return false
  if (rank(current.severity) > rank(prev.severity)) return true
  const grew = current.count - prev.count
  return grew >= 5 && current.count >= prev.count * 1.2
}

export type FindingStatus = 'new' | 'escalated' | 'recurring'

export interface ClassifiedFinding<T extends AuditFindingLike> {
  finding: T
  status: FindingStatus
}

export interface ClassifyResult<T extends AuditFindingLike> {
  classified: ClassifiedFinding<T>[]
  /** True if any finding is NEW or ESCALATED — the trigger for a fresh email. */
  hasNotable: boolean
  notableCount: number
}

/** Classify each current finding against the previously-emailed snapshot. */
export function classifyFindings<T extends AuditFindingLike>(
  current: T[],
  previous: FindingSnapshot,
): ClassifyResult<T> {
  const classified = current.map((f): ClassifiedFinding<T> => {
    const prev = previous[f.check_name]
    let status: FindingStatus
    if (!prev) status = 'new'
    else if (isEscalated(prev, { severity: f.severity, count: f.records_affected })) status = 'escalated'
    else status = 'recurring'
    return { finding: f, status }
  })
  const notableCount = classified.filter(c => c.status !== 'recurring').length
  return { classified, hasNotable: notableCount > 0, notableCount }
}

/**
 * Decide whether to actually send the email this run: there must be a notable
 * change (new/escalated finding) AND it must have been at least `minIntervalHours`
 * since the last email (default 24h) — so a flood of cron runs can't re-spam.
 */
export function shouldSendAuditEmail(opts: {
  hasNotable: boolean
  lastEmailedAt: string | null
  now: Date
  minIntervalHours?: number
}): boolean {
  if (!opts.hasNotable) return false
  if (!opts.lastEmailedAt) return true
  const minMs = (opts.minIntervalHours ?? 24) * 60 * 60 * 1000
  const elapsed = opts.now.getTime() - new Date(opts.lastEmailedAt).getTime()
  return elapsed >= minMs
}
