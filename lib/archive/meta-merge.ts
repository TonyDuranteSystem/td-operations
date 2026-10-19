/**
 * Merge a patch into a submission's `drive_archive_meta` WITHOUT overwriting what is already there (Stop Drive, dev job 264bb882).
 *
 * The sweep writes `sweep_alerted`, the archive job writes its attempt record, the archive success writes where it filed: if each
 * one spread a copy it had read earlier, the last writer would silently drop the others' keys (a lost `sweep_alerted` means a
 * second staff alert). The database function `archive_meta_merge` does `meta || patch` in ONE statement. If the function is not
 * there (the migration has not run yet), this falls back to read-then-write, which narrows the window but is not atomic.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export type ArchiveMetaTable = "tax_return_submissions" | "banking_submissions" | "itin_submissions" | "closure_submissions" | "formation_submissions" | "onboarding_submissions"

export async function mergeArchiveMeta(table: string, id: string, patch: Record<string, unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the function is not in the generated types
  const sb = supabaseAdmin as any
  const { error } = await sb.rpc("archive_meta_merge", { p_table: table, p_id: id, p_patch: patch })
  if (!error) return
  // function missing (migration not run): read-merge-write
  const missing = error.code === "PGRST202" || error.code === "42883" || /could not find the function|does not exist/i.test(error.message ?? "")
  if (!missing) throw new Error(`could not update the archive record: ${error.message}`)
  const { data, error: rErr } = await sb.from(table).select("drive_archive_meta").eq("id", id).maybeSingle()
  if (rErr) throw new Error(`could not read the archive record: ${rErr.message}`)
  const merged = { ...((data?.drive_archive_meta as Record<string, unknown> | null) ?? {}), ...patch }
  const { error: wErr } = await sb.from(table).update({ drive_archive_meta: merged }).eq("id", id)
  if (wErr) throw new Error(`could not update the archive record: ${wErr.message}`)
}
