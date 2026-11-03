/**
 * Bank application intake — where a submitted file's bytes live. A file starts in the intake's own
 * private bucket (browser upload) and, once archived, lives in CRM Storage (Business › BofA); the row's
 * `files` entry then carries `store_file_id`. Every reader (email, staff download) goes through here so
 * it does not matter which side a file is on.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { BOFA_BUCKET } from "./schema"
import { mimeForName, nameForStoredType } from "./archive-names"

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

/** Bucket + path + file type of a stored file's CURRENT version. */
async function storedFileVersion(storeFileId: string): Promise<{ bucket: string; path: string; mimeType: string | null } | null> {
  const { data: file } = await db().from("store_files").select("current_version_id").eq("id", storeFileId).maybeSingle()
  if (!file?.current_version_id) return null
  const { data: v } = await db().from("store_file_versions").select("storage_bucket, storage_path, mime_type").eq("id", file.current_version_id).maybeSingle()
  return v?.storage_bucket && v?.storage_path
    ? { bucket: v.storage_bucket as string, path: v.storage_path as string, mimeType: (v.mime_type as string | null) ?? null }
    : null
}

/** Bucket + path of a stored file's CURRENT version. */
export async function storedFileLocation(storeFileId: string): Promise<{ bucket: string; path: string } | null> {
  const v = await storedFileVersion(storeFileId)
  return v ? { bucket: v.bucket, path: v.path } : null
}

async function locate(f: SubmissionFile): Promise<{ bucket: string; path: string } | null> {
  if (f.store_file_id) return storedFileLocation(f.store_file_id)
  return f.temp_removed ? null : { bucket: BOFA_BUCKET, path: f.path }
}

/**
 * What a submitted file should be CALLED and labelled when it is attached, linked or shown to staff. It describes the bytes that
 * are really in Storage, not the name the applicant's phone gave: an iPhone photo is saved as a JPEG, so "IMG_4521.HEIC" goes out
 * as "IMG_4521.jpg" with an image/jpeg type. If the conversion failed and the original is what is stored, the name stays as it was.
 */
export async function describeSubmissionFile(f: SubmissionFile): Promise<{ name: string; contentType: string }> {
  const stored = f.store_file_id ? await storedFileVersion(f.store_file_id) : null
  const name = nameForStoredType(f.name, stored?.mimeType)
  return { name, contentType: mimeForName(name) }
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
  const { name } = await describeSubmissionFile(f)
  const { data } = await supabaseAdmin.storage.from(loc.bucket).createSignedUrl(loc.path, seconds, { download: name })
  return data?.signedUrl ?? null
}
