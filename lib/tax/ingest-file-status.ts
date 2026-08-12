/**
 * Per-FILE ingest state, derived from `ingest_bank_statement` job rows.
 *
 * ONE implementation for every surface that needs "what happened to each
 * uploaded statement file" (card 4a39e0fd): the client financials GET, the
 * "statements ready" notification gate, and the staff workspace panel. Before
 * this existed, the GET computed it inline and the ready-notification gate
 * counted only in-flight jobs — so a client whose file had FAILED still got
 * "good news, we've finished reading your statements" the moment the last
 * surviving job completed (the false all-clear).
 *
 * Rules (identical to the GET's original byPath logic, plus `quarantined`):
 * - Jobs are grouped by payload.path — one FILE can have several job rows
 *   (reaper re-enqueues, resubmits). Counting jobs told a client "3 files
 *   couldn't be read" for 1 file.
 * - A file is `succeeded` if ANY of its jobs completed with result.ok !== false
 *   — earlier failed attempts for the same path are then irrelevant.
 * - `quarantined` (checked before `failed`): the latest failure carries the
 *   FORMAT_CONFIRMATION_NEEDED marker — the file awaits a one-tap STAFF format
 *   confirmation. To the client this is "still being processed", never
 *   "delete and re-upload".
 * - `failed`: a job failed (or completed with ok:false) and no sibling
 *   succeeded.
 * - `pending`: a job is pending/processing and nothing succeeded yet.
 * - 'cancelled' jobs are ignored entirely (superseded enqueues are not
 *   failures) — callers should exclude them from the query, but rows slipping
 *   through are skipped here too.
 */

export const FORMAT_CONFIRMATION_MARKER = "FORMAT_CONFIRMATION_NEEDED:"

export type IngestFileState = "pending" | "succeeded" | "failed" | "quarantined"

export interface IngestJobRow {
  status: string
  result: { ok?: boolean; steps?: Array<{ detail?: string }> } | null
  payload: { tax_year?: number | string; path?: string } | null
}

function isQuarantineJob(j: IngestJobRow): boolean {
  const steps = j.result?.steps ?? []
  return steps.some(s => typeof s.detail === "string" && s.detail.startsWith(FORMAT_CONFIRMATION_MARKER))
}

/** Group job rows by file path (scoped to taxYear) and resolve one state per file. */
export function computeIngestFileStates(
  jobs: IngestJobRow[],
  taxYear: number,
): Map<string, IngestFileState> {
  const byPath = new Map<string, { succeeded: boolean; pending: boolean; failed: boolean; quarantined: boolean }>()
  for (const j of jobs) {
    if (j.status === "cancelled") continue
    if (String(j.payload?.tax_year ?? "") !== String(taxYear)) continue
    const path = j.payload?.path
    if (!path) continue
    const e = byPath.get(path) ?? { succeeded: false, pending: false, failed: false, quarantined: false }
    if (j.status === "completed" && j.result?.ok !== false) e.succeeded = true
    else if (j.status === "pending" || j.status === "processing") e.pending = true
    else if (j.status === "failed" || (j.status === "completed" && j.result?.ok === false)) {
      if (isQuarantineJob(j)) e.quarantined = true
      else e.failed = true
    }
    byPath.set(path, e)
  }

  const out = new Map<string, IngestFileState>()
  for (const [path, e] of Array.from(byPath.entries())) {
    if (e.succeeded) out.set(path, "succeeded")
    else if (e.pending) out.set(path, "pending")
    else if (e.quarantined) out.set(path, "quarantined")
    else if (e.failed) out.set(path, "failed")
  }
  return out
}

/** Convenience counts for surfaces that only need the totals. */
export function summarizeIngestFileStates(states: Map<string, IngestFileState>): {
  pending: number
  succeeded: number
  failed: number
  quarantined: number
} {
  const sum = { pending: 0, succeeded: 0, failed: 0, quarantined: 0 }
  for (const s of Array.from(states.values())) sum[s]++
  return sum
}
