/**
 * Archive sweeps and the move to the CRM storage (Stop Drive, dev job 264bb882, slice S1c).
 *
 * The tax and banking archive jobs resolve the company's old folder first. A company that has none (every new client) can
 * only make such a job throw on every run, so the backstop sweeps leave that company alone and COUNT it in their result
 * instead of queueing a job that cannot succeed.
 */

/** Pure: split rows into the ones to process and the ones whose company has no folder. A row with no company is kept (the sweep's own rules handle it). */
export function splitByFolder<T extends { account_id?: string | null }>(
  rows: T[],
  accountsWithoutFolder: ReadonlySet<string>,
): { keep: T[]; skipped: T[] } {
  const keep: T[] = []
  const skipped: T[] = []
  for (const r of rows) {
    if (r.account_id && accountsWithoutFolder.has(r.account_id)) skipped.push(r)
    else keep.push(r)
  }
  return { keep, skipped }
}

const CHUNK = 100

/**
 * Of these accounts, the ones that EXIST and have no folder. Strict: a read error throws, so a failed read is never
 * mistaken for "no folder" (an unknown account is NOT in the result, so its row is still processed).
 */
export async function accountsWithoutFolder(accountIds: string[]): Promise<Set<string>> {
  const ids = Array.from(new Set(accountIds.filter(Boolean)))
  const missing = new Set<string>()
  if (ids.length === 0) return missing
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await supabaseAdmin.from("accounts").select("id, drive_folder_id").in("id", ids.slice(i, i + CHUNK))
    if (error) throw new Error(`archive sweep: could not read the accounts' folders — ${error.message}`)
    for (const a of (data ?? []) as Array<{ id: string; drive_folder_id: string | null }>) {
      if (!a.drive_folder_id) missing.add(a.id)
    }
  }
  return missing
}

export interface CandidatePages<T> {
  /** at most `limit` rows that are worth processing, oldest first */
  keep: T[]
  /** how many rows were left alone because their company has no folder */
  skipped: number
  /** set when the folder lookup failed: nothing was skipped on that page and the caller should raise a system error */
  lookupError: string | null
  /** set when a page could not be read */
  readError: string | null
}

/**
 * The sweeps take the OLDEST un-archived rows first. If the rows to skip (storage-only clients that never get a folder) were
 * only removed AFTER a fixed-size window was read, they would fill the window forever and a real row behind them would never
 * be seen. So: read page after page, drop the skippable rows as each page arrives, and stop as soon as `limit` real rows are
 * collected, the data runs out, or `maxPages` pages were read. A skipped row never consumes the window.
 */
export async function collectSweepCandidates<T extends { account_id?: string | null }>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  opts: { limit: number; pageSize: number; maxPages: number },
  lookup: (accountIds: string[]) => Promise<Set<string>> = accountsWithoutFolder,
): Promise<CandidatePages<T>> {
  const out: CandidatePages<T> = { keep: [], skipped: 0, lookupError: null, readError: null }
  for (let page = 0; page < opts.maxPages && out.keep.length < opts.limit; page++) {
    const from = page * opts.pageSize
    const { data, error } = await fetchPage(from, from + opts.pageSize - 1)
    if (error) { out.readError = error.message; break }
    const rows = data ?? []
    let missing = new Set<string>()
    try {
      missing = await lookup(rows.map((r) => r.account_id).filter((x): x is string => !!x))
    } catch (e) {
      out.lookupError = e instanceof Error ? e.message : String(e)
    }
    const split = splitByFolder(rows, missing)
    out.skipped += split.skipped.length
    for (const r of split.keep) {
      if (out.keep.length >= opts.limit) break
      out.keep.push(r)
    }
    if (rows.length < opts.pageSize) break
  }
  return out
}
