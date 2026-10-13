/** Go-live proof helper: the current version of a stored file — its size and sha-256 (null when the file or version is missing). */
export async function readStoreVersionFacts(storeFileId: string): Promise<{ size: number | null; sha256: string | null } | null> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* tables are not in the generated types until production
  const { data, error } = await (supabaseAdmin as any)
    .from("store_files")
    .select("state, store_file_versions!store_files_current_version_fk(size_bytes, sha256)")
    .eq("id", storeFileId)
    .maybeSingle()
  if (error || !data || data.state !== "live") return null
  const v = data.store_file_versions as { size_bytes: number | null; sha256: string | null } | null
  if (!v) return null
  return { size: v.size_bytes ?? null, sha256: v.sha256 ?? null }
}
