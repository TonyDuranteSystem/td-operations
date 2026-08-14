/**
 * Per-FILE ingest state, derived from `ingest_bank_statement` job rows.
 *
 * ONE implementation for every surface that needs "what happened to each
 * uploaded statement file" (card 4a39e0fd). Consumers TODAY: the client
 * financials GET, the "statements ready" notification gate, and the attest
 * hard-block. (The standalone /tools/pnl workspace still has its own older
 * per-path logic — migrating it here is part of the tax-workspace Phase 1
 * work, not yet done.) Before
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
  result: { ok?: boolean; summary?: string; steps?: Array<{ detail?: string }> } | null
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

/** The CLIENT's filename for an upload path — machinery prefixes stripped
 *  (`bank_accounts_0_statements_6a008993_Relay_June.csv` → `Relay_June.csv`,
 *  and the sha16 prefix of the financials-page scheme). One implementation for
 *  the client file cards, the failure notification, and staff surfaces. */
export function displayStatementFileName(path: string): string {
  const fileName = path.split("/").pop() ?? "statement"
  return fileName
    .replace(/^(bank_accounts_\d+_statements|bank_statements)_[a-f0-9]+_/i, "")
    .replace(/^[a-f0-9]{16}_/i, "")
}

export interface IngestFileEntry {
  path: string
  file_name: string
  state: IngestFileState
  /** Plain-language explanation for failed files (the ingest step's guide
   *  text) — shown verbatim on the client file card per Antonio's ruling
   *  ("what happened and how to fix it, never a bare error"). */
  client_error: string | null
  /** Succeeded with ZERO transactions — a valid empty month. Surfaced so the
   *  UI can render a neutral card (round 3: these files vanished from both
   *  lists and the client re-uploaded in confusion). */
  empty?: boolean
  /** Wave 2: WHY the file failed when diagnosable (wrong_year /
   *  not_bank_statement / empty_period / unreadable) — the review component
   *  renders localized copy from lib/tax/ingest-diagnosis.ts, the SAME source
   *  the chat message uses. Absent on legacy jobs → generic copy. */
  diagnosis?: { code: string; found_years?: number[]; expected_year?: number; software?: string } | null
}

/** Full per-file entries (state + display name + failure copy) for file-card
 *  surfaces. Same grouping rules as computeIngestFileStates. */
export function buildIngestFileEntries(jobs: IngestJobRow[], taxYear: number): IngestFileEntry[] {
  const states = computeIngestFileStates(jobs, taxYear)
  // Latest failure detail per path (for failed cards): scan jobs in given
  // order, last matching write wins — callers pass rows in insertion order.
  const failDetail = new Map<string, string>()
  const emptyPaths = new Set<string>()
  const diagByPath = new Map<string, IngestFileEntry["diagnosis"]>()
  for (const j of jobs) {
    const path = j.payload?.path
    if (!path || String(j.payload?.tax_year ?? "") !== String(taxYear)) continue
    if (j.status === "completed" && j.result?.ok !== false && typeof j.result?.summary === "string" && j.result.summary.includes("empty statement period")) {
      emptyPaths.add(path)
    }
    // Latest diagnosis per path (same last-write-wins as the failure detail).
    const diag = (j.result as { diagnosis?: IngestFileEntry["diagnosis"] } | null)?.diagnosis
    if (diag) diagByPath.set(path, diag)
    for (const s of j.result?.steps ?? []) {
      if (typeof s.detail === "string" && !s.detail.startsWith(FORMAT_CONFIRMATION_MARKER)) {
        // Step details are "<file>: <guide text>" — keep the guide text only.
        const idx = s.detail.indexOf(": ")
        if (idx > 0 && (j.status === "failed" || j.result?.ok === false)) {
          failDetail.set(path, s.detail.slice(idx + 2))
        }
      }
    }
  }
  return Array.from(states.entries()).map(([path, state]) => ({
    path,
    file_name: displayStatementFileName(path),
    state,
    // A failed job with NO ingest-step detail died on infrastructure (a
    // thrown transient exhausted its retries) — the copy must not blame the
    // client's file (round 3).
    client_error: state === "failed"
      ? (failDetail.get(path) ?? "This file could not be processed after several tries. This is on our side — our team has been notified; nothing is needed from you.")
      : null,
    ...(state === "succeeded" && emptyPaths.has(path) ? { empty: true } : {}),
    ...(diagByPath.has(path) ? { diagnosis: diagByPath.get(path) } : {}),
  }))
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
