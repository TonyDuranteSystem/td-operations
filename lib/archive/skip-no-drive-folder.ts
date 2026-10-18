/**
 * Archive sweeps and the move to the CRM storage (Stop Drive, dev job 264bb882, slice S1c).
 *
 * The tax and banking archive jobs resolve the company's own old folder first. Two kinds of company can never be archived by
 * them and must not take a place in the sweep's window of 200 oldest rows:
 *   - a company with NO folder (every new, storage-first client): the job could only throw on every run;
 *   - a Closed / Cancelled company: its old folder is a read-only archive, nothing new is written there.
 * The window is filtered IN THE QUERY (an inner join on the company), so these rows never occupy it however many there are —
 * there is no page limit that starvation could come back through.
 *
 * Skipping is never silent for a storage-first client: a submission of a company with no folder that nobody has filed is reported
 * through ONE staff-visible alarm per run (a system error with the ids) until it is filed, and the counts are in the cron result.
 */

const FINISHED = ["Closed", "Cancelled"] as const
const FINISHED_FILTER = `(${FINISHED.join(",")})`

export interface SweepWindows<T> {
  /** at most `limit` rows of companies that HAVE a folder and are not finished, oldest first — what the sweep processes */
  withFolder: T[]
  /** at most `limit` rows of (not finished) companies with NO folder — only used to raise the alarm */
  noFolder: T[]
  /** how many un-archived rows were left alone because the company has no folder */
  skippedNoFolder: number
  /** how many were left alone because the company is Closed / Cancelled */
  skippedFinished: number
  readError: string | null
}

const SELECT_JOIN = "accounts!inner(drive_folder_id, status)"

/**
 * Read the three views of one submissions table. `table` and `columns` come from the sweep (never from a request).
 * Rows with no company are not returned (an archive job cannot do anything with them).
 */
export async function readSweepWindows<T>(
  table: string,
  columns: string,
  cutoffIso: string,
  limit = 200,
): Promise<SweepWindows<T>> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the table is a runtime string; the join column is not in the generated types
  const sb = supabaseAdmin as any
  const base = (cols: string, opts?: { count: "exact"; head: true }) =>
    sb.from(table).select(`${cols}, ${SELECT_JOIN}`, opts).is("drive_archived_at", null).gte("created_at", cutoffIso)

  const out: SweepWindows<T> = { withFolder: [], noFolder: [], skippedNoFolder: 0, skippedFinished: 0, readError: null }

  const a = await base(columns)
    .not("accounts.drive_folder_id", "is", null)
    .not("accounts.status", "in", FINISHED_FILTER)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit)
  if (a.error) { out.readError = a.error.message; return out }
  out.withFolder = (a.data ?? []) as T[]

  const b = await base(columns)
    .is("accounts.drive_folder_id", null)
    .not("accounts.status", "in", FINISHED_FILTER)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit)
  if (b.error) { out.readError = b.error.message; return out }
  out.noFolder = (b.data ?? []) as T[]

  const c = await base("id", { count: "exact", head: true }).is("accounts.drive_folder_id", null).not("accounts.status", "in", FINISHED_FILTER)
  if (c.error) { out.readError = c.error.message; return out }
  out.skippedNoFolder = c.count ?? out.noFolder.length

  const d = await base("id", { count: "exact", head: true }).in("accounts.status", [...FINISHED])
  if (d.error) { out.readError = d.error.message; return out }
  out.skippedFinished = d.count ?? 0

  return out
}

/** Pure: of the no-folder rows, the ones nobody has filed that are past the sweep's own grace window (it would enqueue or alert them). */
export function unfiledOf<T>(rows: T[], decide: (r: T) => "skip" | "enqueue" | "alert"): T[] {
  return rows.filter((r) => decide(r) !== "skip")
}

/**
 * ONE staff-visible alarm (a system error) for submissions of companies with no folder that are not filed anywhere. Same message
 * every run, so it stays ONE open entry until the submissions are filed; the ids are in the context. Never throws.
 */
export async function raiseUnfiledAlarm(route: string, what: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  try {
    const { reportSystemError } = await import("@/lib/system-errors")
    await reportSystemError({
      source: "server",
      route,
      message: `${what} of companies with no folder are not filed anywhere yet — they need to be filed in the company storage`,
      context: { count: ids.length, ids: ids.slice(0, 50) },
    })
  } catch { /* an alarm never breaks a sweep */ }
}
