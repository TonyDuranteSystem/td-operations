/**
 * Banking — record that a submission's package was filed (Stop Drive S1d, dev job 264bb882).
 *
 * The archive engine sets `drive_archived_at` (+ meta) when ITS job files a package; that marker is what the sweep keys on. A package
 * filed INLINE (the wizard, the public banking form, the staff review tool) never set it, so the sweep kept treating a client who IS
 * filed as "not filed anywhere" and alarmed on every run. The inline lanes now set the very same marker when — and only when — the
 * whole package was filed, and queue the durable job only when it was not.
 */

export interface FiledInfo {
  flow: string
  summaryFileId: string | null
  copied: string[]
  folderId: string | null
}

export async function markBankingSubmissionFiled(submissionId: string, info: FiledInfo, now: Date = new Date()): Promise<boolean> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const { data: row, error } = await supabaseAdmin.from("banking_submissions").select("drive_archive_meta").eq("id", submissionId).maybeSingle()
  if (error) return false
  const prior = ((row as { drive_archive_meta?: Record<string, unknown> | null } | null)?.drive_archive_meta ?? {}) as Record<string, unknown>
  const { error: upErr } = await supabaseAdmin
    .from("banking_submissions")
    // as never: the archive columns are not in the generated types (same as the archive engine)
    .update({
      drive_archived_at: now.toISOString(),
      drive_archive_meta: { ...prior, last_error: null, filed_by: info.flow, summary_file_id: info.summaryFileId, copied: info.copied, drive_folder_id: info.folderId },
    } as never)
    .eq("id", submissionId)
  return !upErr
}
