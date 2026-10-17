/**
 * Opening a file for the Mac app (dev job 1992a087, P1). The server decides EVERYTHING; the app only follows:
 *   - not found / trashed / purged / hidden storage / someone else's My files  → 404 (same answer for all)
 *   - a sensitive document (passport, ID, ITIN papers, untyped file in a person storage) OPENS like any other since 2026-10-17 (Antonio),
 *     but gets an extra audit row (if that row cannot be written, no link) and a shorter keep time for the Mac's copy
 *   - over the hourly download limit → 429 + an audit row
 *   - otherwise a SIGNED LINK valid 60 seconds (one per request, never logged or stored in the audit), plus size / type / sha-256 so the
 *     app can check what it received. Every open is an audit row (user, device, file, size).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAppEvent } from "./device-auth"
import { keepSecondsFor } from "./sensitive"
import { readLimitBytes } from "./read-limit"
import type { AppItem } from "./listing"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any
export const LINK_SECONDS = 60

export type OpenResult =
  | { status: 200; body: { url: string; name: string; size: number | null; mimeType: string | null; sha256: string | null; expiresIn: number; sensitive: boolean; keepSeconds: number } }
  | { status: 404; body: { error: "Not found." } }
  | { status: 429; body: { error: "download_limit"; message: string } }

export async function currentVersion(fileId: string): Promise<{ bucket: string; path: string; size: number | null; mimeType: string | null; sha256: string | null } | null> {
  const { data: f, error } = await db().from("store_files").select("current_version_id").eq("id", fileId).maybeSingle()
  if (error || !f?.current_version_id) return null
  const { data: v, error: vErr } = await db().from("store_file_versions").select("storage_bucket, storage_path, size_bytes, mime_type, sha256").eq("id", f.current_version_id).maybeSingle()
  if (vErr || !v) return null
  return { bucket: v.storage_bucket, path: v.storage_path, size: v.size_bytes ?? null, mimeType: v.mime_type ?? null, sha256: v.sha256 ?? null }
}

/** `item` is the already-checked file (live, in a live storage this login may open). */
export async function openFileForDevice(p: { item: AppItem; userId: string; deviceId: string; ip?: string | null }): Promise<OpenResult> {
  const ids = { ownerId: p.item.ownerId, fileId: p.item.id }
  const sensitive = p.item.sensitive === true
  const v = await currentVersion(p.item.id)
  if (!v) return { status: 404, body: { error: "Not found." } }
  // ONE atomic step: count what this Mac and this person opened in the last hour, refuse if this file does not fit, else write the audit row.
  // A database error here throws → no link (fail closed).
  const limit = readLimitBytes()
  const { data: reserve, error: rErr } = await db().rpc("storage_app_reserve_read", {
    p_device: p.deviceId, p_user: p.userId, p_owner: p.item.ownerId, p_file: p.item.id, p_name: p.item.name, p_size: v.size, p_device_limit: limit, p_user_limit: limit,
  })
  if (rErr) throw new Error(`Could not check the download limit (${rErr.message}).`)
  if (!(reserve as { allowed?: boolean } | null)?.allowed) {
    return { status: 429, body: { error: "download_limit", message: "This Mac has downloaded a lot in the last hour. Try again later, or open the files in the CRM." } }
  }
  // a sensitive paper opens, but never without its own audit row: no row → no link (fail closed)
  if (sensitive && !(await logAppEvent("app_sensitive_file_opened", p.userId, { deviceId: p.deviceId, name: p.item.name, size: v.size }, ids))) {
    throw new Error("Could not record this open, so the file was not released.")
  }
  const { data, error } = await supabaseAdmin.storage.from(v.bucket).createSignedUrl(v.path, LINK_SECONDS)
  if (error || !data?.signedUrl) throw new Error(`Could not prepare the download (${error?.message ?? "no link"}).`)
  return { status: 200, body: { url: data.signedUrl, name: p.item.name, size: v.size, mimeType: v.mimeType, sha256: v.sha256, expiresIn: LINK_SECONDS, sensitive, keepSeconds: keepSecondsFor(sensitive) } }
}
