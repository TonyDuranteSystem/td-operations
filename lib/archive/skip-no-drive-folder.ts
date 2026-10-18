/**
 * Archive sweeps and the move to the CRM storage (Stop Drive, dev job 264bb882, slice S1c).
 *
 * The sweep takes the OLDEST 200 un-archived rows that its archive job can act on. Rows that can never be acted on must not
 * take a place in that window, however many there are, so the filter is IN THE QUERY (never "read 200, then skip"):
 *   - unfilled shells (a form that was created and sent but never completed);
 *   - rows whose attempts are used up AND already alerted (their one alert has fired — a human owns them now);
 *   - rows of a Closed / Cancelled company (its old folder is a read-only archive; nothing new is written there).
 * A company with no folder is NOT skipped: the archive job files it in the company's storage (see saveFormForAccount), and
 * sets the same marker (drive_archived_at) that takes the row out of the window for good. A company that can receive nothing
 * makes the job fail, its attempts climb, and the sweep's existing ONE alert fires and is remembered — loud once, not forever.
 */

const FINISHED = ["Closed", "Cancelled"] as const
const FINISHED_NOT_IN = `(${FINISHED.join(",")})`

export interface SweepWindow<T> {
  /** at most `limit` actionable rows, oldest first (rows with a company first; completed rows with NO company are added so they stay loud) */
  candidates: T[]
  /** how many actionable-looking un-archived rows were left alone because the company is Closed / Cancelled */
  skippedFinished: number
  readError: string | null
}

/**
 * @param realFilter a PostgREST `or` expression that keeps only REAL submissions (completed, not an unfilled shell)
 */
export async function readSweepWindow<T>(
  table: string,
  columns: string,
  cutoffIso: string,
  realFilter: string,
  limit = 200,
): Promise<SweepWindow<T>> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the table is a runtime string; the join column is not in the generated types
  const sb = supabaseAdmin as any
  const base = (cols: string, opts?: { count: "exact"; head: true }) =>
    sb.from(table).select(cols, opts)
      .is("drive_archived_at", null)
      .gte("created_at", cutoffIso)
      .or(realFilter)
      .is("drive_archive_meta->>sweep_alerted", null)

  const out: SweepWindow<T> = { candidates: [], skippedFinished: 0, readError: null }

  // (1) rows of companies that are not finished (a missing status counts as not finished)
  const a = await base(`${columns}, accounts!inner(status)`)
    .or(`status.is.null,status.not.in.${FINISHED_NOT_IN}`, { referencedTable: "accounts" })
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
  const c = await base("id, accounts!inner(status)", { count: "exact", head: true }).in("accounts.status", [...FINISHED])
  if (c.error) { out.readError = c.error.message; return out }
  out.skippedFinished = c.count ?? 0

  return out
}
