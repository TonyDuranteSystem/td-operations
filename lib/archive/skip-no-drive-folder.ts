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
