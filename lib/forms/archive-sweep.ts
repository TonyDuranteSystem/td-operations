/**
 * Backstop sweep for non-tax form Drive archival (2026-07-24) — the DISCOVERY net.
 *
 * job_queue handles per-submission RETRY; this finds submissions whose archival
 * never completed (the completion route died before enqueuing, a transient blip,
 * a genuinely-absent folder) and either re-enqueues the durable archive job or,
 * once attempts are exhausted, raises the ONE loud staff alert. Mirrors the tax
 * sweep's guard set (forward-only cutoff, grace, attempt cap, alerted-key) so it
 * can't storm, race a live job, or re-chase pre-feature history.
 *
 * PER-FORM / PER-TABLE by construction: the cron iterates the recipe registry and
 * queries each form's OWN table + columns. There is deliberately NO shared SELECT
 * across tables — review_status/account_id are tax-only, and each form's "real
 * submission" predicate differs, so one shared query would mis-key rows.
 *
 * These constants MIRROR lib/tax/archive-sweep.ts (kept separate to avoid coupling
 * the generic engine to the tax module — same invariants, independently owned).
 */

import type { ArchiveRecipe } from "@/lib/forms/archive-registry"

/** Forward-only: submissions created before this are the pre-feature backlog and
 *  are NOT auto-archived by the sweep (re-save individually if ever needed). */
export const FORM_ARCHIVE_SWEEP_CUTOFF_ISO = "2026-07-24T00:00:00Z"

/** Don't touch a submission younger than this — its live archive job may still be
 *  running (avoids two writers racing into the same Drive folder). */
export const FORM_ARCHIVE_SWEEP_GRACE_MINUTES = 20

/** Re-enqueue at most this many per run (each triggers real Drive work). */
export const FORM_ARCHIVE_SWEEP_MAX_PER_RUN = 10

/** After this many failed attempts, stop re-enqueuing and only ALERT — a
 *  persistently failing archival needs a human (missing folder, oversized file),
 *  not an infinite retry. */
export const FORM_ARCHIVE_SWEEP_MAX_ATTEMPTS = 5

/** meta key marking that a stuck-row alert already fired (no re-alert storm). */
export const FORM_ARCHIVE_SWEEP_ALERTED_KEY = "sweep_alerted"

/** Team-chat channel for the ⚠️ digest. */
export const FORM_ARCHIVE_SWEEP_CHANNEL = "td-support"

export type FormArchiveSweepAction = "enqueue" | "alert" | "skip"

export function attemptsOf(meta: Record<string, unknown> | null | undefined): number {
  const n = Number((meta ?? {})["attempts"])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export function alreadyAlerted(meta: Record<string, unknown> | null | undefined): boolean {
  return (meta ?? {})[FORM_ARCHIVE_SWEEP_ALERTED_KEY] === true
}

/**
 * Decide what to do with one candidate row for a given form recipe. Pure — the
 * cron loads rows and performs the IO.
 *  - already archived                     → skip (shouldn't be selected)
 *  - not a real submission (draft/shell)  → skip
 *  - before cutoff / inside grace window  → skip (forward-only / racing)
 *  - attempts exhausted, not yet alerted  → alert
 *  - attempts exhausted, already alerted  → skip
 *  - otherwise                            → enqueue
 *
 * NOTE: no account_id gate here (unlike the tax sweep) — some forms legitimately
 * carry no account. A completed row whose destination can't be resolved surfaces
 * as a failing job → attempts climb → alert, which is the loud path we want.
 */
export function decideFormArchiveSweep(
  row: Record<string, unknown>,
  recipe: ArchiveRecipe,
  now: Date,
): FormArchiveSweepAction {
  if (row.drive_archived_at) return "skip"
  if (!recipe.isReal(row)) return "skip"

  const created = Date.parse(String(row.created_at ?? ""))
  if (Number.isNaN(created)) return "skip"
  if (created < Date.parse(FORM_ARCHIVE_SWEEP_CUTOFF_ISO)) return "skip" // forward-only
  if (created > now.getTime() - FORM_ARCHIVE_SWEEP_GRACE_MINUTES * 60_000) return "skip" // still in grace

  const attempts = attemptsOf(row.drive_archive_meta as Record<string, unknown> | null)
  if (attempts >= FORM_ARCHIVE_SWEEP_MAX_ATTEMPTS) {
    return alreadyAlerted(row.drive_archive_meta as Record<string, unknown> | null) ? "skip" : "alert"
  }
  return "enqueue"
}
