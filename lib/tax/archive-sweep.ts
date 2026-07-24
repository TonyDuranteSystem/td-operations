/**
 * Backstop sweep for tax-submission Drive archival (2026-07-24).
 *
 * job_queue handles per-submission RETRY; this sweep handles DISCOVERY — it
 * finds submissions whose Drive archival never completed (the setup job died
 * before enqueuing, a transient blip, a genuinely-absent folder) and either
 * re-enqueues the durable archive job or, once attempts are exhausted, raises
 * the ONE loud staff alert. Mirrors completion-sweep's guard set so it can't
 * storm, race a live job, or re-chase ancient history.
 *
 * CRITICAL — the marker column is NEW, so drive_archived_at IS NULL matches
 * EVERY historical submission. The cutoff makes the sweep forward-only: it never
 * mass-reprocesses the hundreds of pre-existing rows. Old packages are left as
 * they are (re-save individually if needed).
 */

/** Forward-only: submissions created before this are the pre-feature backlog and
 *  are NOT auto-archived by the sweep. Set to the ship moment. */
export const ARCHIVE_SWEEP_CUTOFF_ISO = "2026-07-24T00:00:00Z"

/** Don't touch a submission younger than this — its live archive job may still
 *  be running (avoids two writers racing into the same Drive folder). */
export const ARCHIVE_SWEEP_GRACE_MINUTES = 20

/** Re-enqueue at most this many per run (each triggers real Drive work). */
export const ARCHIVE_SWEEP_MAX_PER_RUN = 10

/** After this many failed attempts, stop re-enqueuing and only ALERT — a
 *  persistently failing archival needs a human (missing folder, oversized file),
 *  not an infinite retry. */
export const ARCHIVE_SWEEP_MAX_ATTEMPTS = 5

/** meta key marking that a stuck-row alert already fired (no re-alert storm). */
export const ARCHIVE_SWEEP_ALERTED_KEY = "sweep_alerted"

/** Team-chat channel for the ⚠️ digest. */
export const ARCHIVE_SWEEP_CHANNEL = "td-taxreturn"

export interface ArchiveSweepRow {
  id: string
  account_id: string | null
  status: string | null
  review_status: string | null
  created_at: string
  drive_archived_at: string | null
  drive_archive_meta: Record<string, unknown> | null
}

export type ArchiveSweepAction = "enqueue" | "alert" | "skip"

export function attemptsOf(meta: Record<string, unknown> | null | undefined): number {
  const n = Number((meta ?? {})["attempts"])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export function alreadyAlerted(meta: Record<string, unknown> | null | undefined): boolean {
  return (meta ?? {})[ARCHIVE_SWEEP_ALERTED_KEY] === true
}

/**
 * Decide what to do with one candidate row. Pure — the cron loads rows and
 * performs the IO.
 *  - already archived                         → skip (shouldn't be selected)
 *  - draft/empty shell or no account          → skip (nothing to archive)
 *  - before cutoff / inside grace window      → skip (forward-only / racing)
 *  - attempts exhausted, not yet alerted      → alert
 *  - attempts exhausted, already alerted      → skip
 *  - otherwise                                → enqueue
 */
export function decideArchiveSweep(row: ArchiveSweepRow, now: Date): ArchiveSweepAction {
  if (row.drive_archived_at) return "skip"
  if (!row.account_id) return "skip"
  // Only real submissions (not the empty pending shells) get archived.
  const isReal = row.status === "completed" || row.status === "reviewed" || row.review_status !== null
  if (!isReal) return "skip"

  const created = Date.parse(row.created_at)
  if (Number.isNaN(created)) return "skip"
  if (created < Date.parse(ARCHIVE_SWEEP_CUTOFF_ISO)) return "skip" // forward-only
  if (created > now.getTime() - ARCHIVE_SWEEP_GRACE_MINUTES * 60_000) return "skip" // still in grace

  const attempts = attemptsOf(row.drive_archive_meta)
  if (attempts >= ARCHIVE_SWEEP_MAX_ATTEMPTS) {
    return alreadyAlerted(row.drive_archive_meta) ? "skip" : "alert"
  }
  return "enqueue"
}
