/**
 * Shared server-side gate for the public token+code "signing link" pages
 * (SS-4, ITIN, and the rest of the public form family).
 *
 * These pages used to query Supabase directly from the browser with the anon
 * key, trusting a client-supplied `.eq("token", token)` filter to scope the
 * result. That filter is not enforced by the database — the underlying RLS
 * policies allow the table's SELECT/UPDATE unconditionally for anon, so a
 * request that skips the filter (or targets the table directly via the
 * REST API) returns every row. This helper does the token+code check
 * server-side with the service role, so the anon grant can be revoked
 * without breaking the legitimate flow. Mirrors the pattern already used by
 * app/api/ss4/[token]/upload-signed (isStaffPreview + access_code compare).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { isStaffPreview } from "@/lib/auth/staff-preview"

export interface VerifiedAccess<T> {
  ok: true
  row: T
  isAdmin: boolean
}

export interface DeniedAccess {
  ok: false
  status: 403 | 404
  error: string
}

/**
 * Look up a row by `token`, then require EITHER a real staff session
 * (preview=td flag + isStaffPreview) OR a matching `access_code`.
 * Fails closed: any lookup error, missing row, or code mismatch denies.
 */
export async function verifyTokenAccess<T extends { access_code: string | null }>(
  table: string,
  select: string,
  token: string,
  code: string | null,
  previewRequested: boolean,
): Promise<VerifiedAccess<T> | DeniedAccess> {
  const { data, error } = await supabaseAdmin
    .from(table)
    .select(select)
    .eq("token", token)
    .maybeSingle()

  if (error || !data) {
    return { ok: false, status: 404, error: "Not found" }
  }

  const row = data as unknown as T
  const isAdmin = await isStaffPreview(previewRequested)
  if (!isAdmin && row.access_code !== code) {
    return { ok: false, status: 403, error: "Invalid access code" }
  }

  return { ok: true, row, isAdmin }
}
