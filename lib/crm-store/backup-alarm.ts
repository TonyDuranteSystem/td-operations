/**
 * The backup's "something is wrong" signal (Drive cutover Phase 4, dev job ad09ea91). Until now the completeness functions
 * existed but nothing ever looked at them. One check, run by the scheduled route right after it queues the work:
 *
 *   - a storage whose backup keeps FAILING (3+ failed runs),
 *   - a storage with changes waiting longer than the limit (the backup is not keeping up),
 *   - a live file whose Drive copy is missing / does not match, for a storage that HAS had a successful backup
 *     (a brand-new storage is "never backed up" instead — that is not a missing file, it is a backup that has not run),
 *   - a storage with files that has still never been backed up after the limit.
 *
 * The result is a short list of plain sentences; the route raises ONE system error carrying them (the error board is where
 * staff already look) and stays quiet when the list is empty.
 */

export const NEVER_BACKED_UP_AFTER_HOURS = 6

export interface BackupGapCounts { owner_failing?: number; owner_late?: number; missing_file?: number; protected_missing?: number; no_bytes?: number }
export interface BackupGapSample { kind: string; owner_id: string; file_id: string | null; detail: string | null }
export interface NeverBackedUpOwner { owner_id: string; created_at: string }

/** Pure: the problems worth raising. `succeededOwners` = owners whose backup has succeeded at least once. */
export function classifyBackupProblems(p: {
  counts: BackupGapCounts
  sample: BackupGapSample[]
  succeededOwners: Set<string>
  neverBackedUp: NeverBackedUpOwner[]
  now?: Date
}): string[] {
  const out: string[] = []
  const now = p.now ?? new Date()
  if ((p.counts.owner_failing ?? 0) > 0) out.push(`${p.counts.owner_failing} storage(s) have failed their backup 3 or more times in a row`)
  if ((p.counts.owner_late ?? 0) > 0) out.push(`${p.counts.owner_late} storage(s) have changes waiting for backup for more than 6 hours`)
  if ((p.counts.no_bytes ?? 0) > 0) out.push(`${p.counts.no_bytes} live file(s) have no saved version, so there is nothing to back up`)
  // a missing Drive copy only counts once that storage has had a successful backup (a new storage has not been backed up YET)
  const real = p.sample.filter((g) => (g.kind === "missing_file" || g.kind === "protected_missing") && p.succeededOwners.has(g.owner_id))
  const missing = real.filter((g) => g.kind === "missing_file").length
  const protectedMissing = real.filter((g) => g.kind === "protected_missing").length
  if (missing > 0) out.push(`${missing}+ live file(s) are missing or different in the Drive backup (storages that were backed up before)`)
  if (protectedMissing > 0) out.push(`${protectedMissing}+ trashed file(s) are missing from the protected backup area`)
  const limit = NEVER_BACKED_UP_AFTER_HOURS * 3_600_000
  const stale = p.neverBackedUp.filter((o) => now.getTime() - Date.parse(o.created_at) > limit)
  if (stale.length > 0) out.push(`${stale.length} storage(s) with files have still never been backed up (oldest created ${stale.map((o) => o.created_at).sort()[0]})`)
  return out
}

/** Reads the facts and classifies them. Never throws: a failed read is itself a problem to report. */
export async function runBackupAlarm(): Promise<{ problems: string[]; counts: BackupGapCounts }> {
  const { backupGaps } = await import("./backup")
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
  const db = supabaseAdmin as any
  try {
    const gaps = await backupGaps()
    const ownerIds = Array.from(new Set(gaps.sample.map((g) => g.owner_id)))
    const succeeded = new Set<string>()
    for (let i = 0; i < ownerIds.length; i += 100) {
      const { data, error } = await db.from("store_backup_state").select("owner_id").in("owner_id", ownerIds.slice(i, i + 100)).not("last_success_at", "is", null)
      if (error) throw new Error(error.message)
      for (const r of (data ?? []) as Array<{ owner_id: string }>) succeeded.add(r.owner_id)
    }
    // storages that are in scope for the backup, have files and have never had a successful run
    const { data: due, error: dueErr } = await db.rpc("store_backup_dirty_owners", { p_limit: 1000 })
    if (dueErr) throw new Error(dueErr.message)
    const neverIds = ((due ?? []) as Array<{ owner_id: string; reason: string }>).filter((d) => d.reason === "never").map((d) => d.owner_id)
    const never: NeverBackedUpOwner[] = []
    for (let i = 0; i < neverIds.length; i += 100) {
      const { data, error } = await db.from("store_owners").select("id, created_at").in("id", neverIds.slice(i, i + 100))
      if (error) throw new Error(error.message)
      for (const r of (data ?? []) as Array<{ id: string; created_at: string }>) never.push({ owner_id: r.id, created_at: r.created_at })
    }
    return { problems: classifyBackupProblems({ counts: gaps.counts, sample: gaps.sample, succeededOwners: succeeded, neverBackedUp: never }), counts: gaps.counts }
  } catch (e) {
    return { problems: [`the backup alarm could not be read: ${e instanceof Error ? e.message : String(e)}`], counts: {} }
  }
}
