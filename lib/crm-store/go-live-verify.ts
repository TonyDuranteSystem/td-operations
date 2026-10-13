/** Go-live proof helper: the byte size of a stored file's current version (null when the file or version is missing). */
export async function readStoreVersionSize(storeFileId: string): Promise<number | null> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* tables are not in the generated types until production
  const { data, error } = await (supabaseAdmin as any)
    .from("store_files")
    .select("state, store_file_versions!store_files_current_version_fk(size_bytes)")
    .eq("id", storeFileId)
    .maybeSingle()
  if (error || !data || data.state !== "live") return null
  const v = data.store_file_versions as { size_bytes: number | null } | null
  return v?.size_bytes ?? null
}
