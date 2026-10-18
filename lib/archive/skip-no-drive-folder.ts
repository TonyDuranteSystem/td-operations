/**
 * Archive sweeps and the move to the CRM storage (Stop Drive, dev job 264bb882, slice S1c).
 *
 * The sweep takes the OLDEST 200 un-archived rows that its archive job can act on. Rows that can never be acted on must not
 * take a place in that window, however many there are, so the filter is IN THE QUERY (never "read 200, then skip"):
 *   - unfilled shells (a form that was created and sent but never completed);
 *   - rows whose attempts are used up AND already alerted (their one alert has fired — a human owns them now);
 *   - rows of a Closed / Cancelled company (its old folder is a read-only archive; nothing new is written there). ONE rule for
 *     "finished": the list in no-storage.ts (`FINISHED_DB_LABELS` — `accounts.status` is a database enum, so exact labels).
 * A company with no folder is NOT skipped: the archive job files it in the company's storage (see saveFormForAccount), and
 * sets the same marker (drive_archived_at) that takes the row out of the window for good. A company that can receive nothing
 * makes the job fail, its attempts climb, and the sweep's existing ONE alert fires and is remembered — loud once, not forever.
 */

import { FINISHED_DB_LABELS } from "@/lib/crm-store/no-storage"

export interface SweepWindow<T> {
  /** at most `limit` actionable rows, oldest first (rows with a company first; completed rows with NO company are added so they stay loud) */
  candidates: T[]
  /** how many actionable-looking un-archived rows were left alone because the company is Closed / Cancelled */
  skippedFinished: number
  readError: string | null
}

export interface SweepWindowOptions {
  /** a PostgREST `or` expression that keeps only REAL submissions (completed, not an unfilled shell) */
  realFilter: string
  /** forms are older than this are not swept (forward-only); ISO */
  cutoffIso: string
  /** false for a table with no account_id (a lead-stage form): no company join and no finished-company filter */
  hasAccount?: boolean
  limit?: number
}

/** `status` is not one of the finished statuses, or is missing. */
const NOT_FINISHED = `status.is.null,status.not.in.(${FINISHED_DB_LABELS.join(",")})`
/** `status` is one of the finished statuses. */
const IS_FINISHED = `status.in.(${FINISHED_DB_LABELS.join(",")})`

export async function readSweepWindow<T>(table: string, columns: string, opts: SweepWindowOptions): Promise<SweepWindow<T>> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the table is a runtime string; the join column is not in the generated types
  const sb = supabaseAdmin as any
  const limit = opts.limit ?? 200
  const hasAccount = opts.hasAccount !== false
  const base = (cols: string, o?: { count: "exact"; head: true }) =>
    sb.from(table).select(cols, o)
      .is("drive_archived_at", null)
      .gte("created_at", opts.cutoffIso)
      .or(opts.realFilter)
      .is("drive_archive_meta->>sweep_alerted", null)

  const out: SweepWindow<T> = { candidates: [], skippedFinished: 0, readError: null }

  if (!hasAccount) {
    const r = await base(columns).order("created_at", { ascending: true }).order("id", { ascending: true }).limit(limit)
    if (r.error) { out.readError = r.error.message; return out }
    out.candidates = (r.data ?? []) as T[]
    return out
  }

  // (1) rows of companies that are not finished (a missing status counts as not finished)
  const a = await base(`${columns}, accounts!inner(status)`)
    .or(NOT_FINISHED, { referencedTable: "accounts" })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit)
  if (a.error) { out.readError = a.error.message; return out }
  out.candidates = (a.data ?? []) as T[]

  // (2) completed rows with NO company: the archive job fails on them (nothing to file them against) so they stay loud
  const b = await base(columns)
    .is("account_id", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit)
  if (b.error) { out.readError = b.error.message; return out }
  const seen = new Set((out.candidates as Array<{ id?: string }>).map((r) => r.id))
  for (const r of (b.data ?? []) as Array<T & { id?: string }>) if (!seen.has(r.id)) out.candidates.push(r)

  // (3) how many were left alone because the company is finished
  const c = await base("id, accounts!inner(status)", { count: "exact", head: true }).or(IS_FINISHED, { referencedTable: "accounts" })
  if (c.error) { out.readError = c.error.message; return out }
  out.skippedFinished = c.count ?? 0

  return out
}
