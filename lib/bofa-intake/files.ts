/**
 * Bank application intake — where a submitted file's bytes live. A file starts in the intake's own
 * private bucket (browser upload) and, once archived, lives in CRM Storage (Business › BofA); the row's
 * `files` entry then carries `store_file_id`. Every reader (email, staff download) goes through here so
 * it does not matter which side a file is on.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { BOFA_BUCKET } from "./schema"

export interface SubmissionFile {
  key: string
  name: string
  /** path in the intake bucket (deleted once the file is archived) */
  path: string
  /** set once the file is saved in CRM Storage */
  store_file_id?: string
  temp_removed?: boolean
}

// store_* tables are not in the generated DB types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

/** Bucket + path of a stored file's CURRENT version. */
export async function storedFileLocation(storeFileId: string): Promise<{ bucket: string; path: string } | null> {
  const { data: file } = await db().from("store_files").select("current_version_id").eq("id", storeFileId).maybeSingle()
  if (!file?.current_version_id) return null
  const { data: v } = await db().from("store_file_versions").select("storage_bucket, storage_path").eq("id", file.current_version_id).maybeSingle()
  return v?.storage_bucket && v?.storage_path ? { bucket: v.storage_bucket as string, path: v.storage_path as string } : null
}

async function locate(f: SubmissionFile): Promise<{ bucket: string; path: string } | null> {
  if (f.store_file_id) return storedFileLocation(f.store_file_id)
  return f.temp_removed ? null : { bucket: BOFA_BUCKET, path: f.path }
}

export async function readSubmissionFile(f: SubmissionFile): Promise<Buffer | null> {
  const loc = await locate(f)
  if (!loc) return null
  const { data, error } = await supabaseAdmin.storage.from(loc.bucket).download(loc.path)
  if (error || !data) return null
  return Buffer.from(await data.arrayBuffer())
}

export async function signedUrlForSubmissionFile(f: SubmissionFile, seconds: number): Promise<string | null> {
  const loc = await locate(f)
  if (!loc) return null
  const { data } = await supabaseAdmin.storage.from(loc.bucket).createSignedUrl(loc.path, seconds, { download: f.name })
  return data?.signedUrl ?? null
}
