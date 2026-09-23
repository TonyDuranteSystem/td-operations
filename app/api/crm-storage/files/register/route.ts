/**
 * POST /api/crm-storage/files/register  { storage_path, file_name, folder_id?, file_size, mime_type? }
 *
 * Second step of a large-file upload: the browser has already put the
 * bytes straight into storage via a resumable upload (see
 * lib/crm-storage/resumable-upload-client.ts) using its own signed-in
 * session — our server never saw them. This just records the index row
 * now that the object genuinely exists, re-checking the name is still
 * free (something else could have taken it during the transfer) and
 * cleaning up the orphaned object if it has.
 *
 * Staff-only.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { validateStorageName, escapeIlikePattern } from "@/lib/crm-storage/name-guard"
import { CRM_STORAGE_BUCKET } from "@/lib/crm-storage/constants"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function POST(req: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const body = await req.json().catch(() => ({}))
  const nameCheck = validateStorageName(body.file_name)
  if (nameCheck.error) return NextResponse.json({ error: nameCheck.error }, { status: 400 })

  const storagePath = typeof body.storage_path === "string" && body.storage_path ? body.storage_path : null
  if (!storagePath) return NextResponse.json({ error: "Missing storage_path" }, { status: 400 })

  const folderId = typeof body.folder_id === "string" && body.folder_id ? body.folder_id : null
  const mimeType = typeof body.mime_type === "string" && body.mime_type ? body.mime_type : null

  // The client-reported size (and every downstream size gate that later
  // trusts crm_storage_files.file_size) used to come straight from this
  // request body with no check against the actual uploaded object — a
  // direct call could claim any size for a real, much larger file, quietly
  // defeating the share-route size limits. Read the real object's size from
  // Storage itself instead of trusting the caller (bug-hunter, 2026-09-23).
  const { data: objectList, error: listErr } = await db.storage
    .from(CRM_STORAGE_BUCKET)
    .list("", { search: storagePath, limit: 1 })
  const objectInfo = (objectList || []).find((o: { name: string }) => o.name === storagePath)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const realFileSize = typeof (objectInfo as any)?.metadata?.size === "number" ? (objectInfo as any).metadata.size : null
  if (listErr || !objectInfo || realFileSize == null) {
    return NextResponse.json({ error: "Could not verify the upload. Please try again." }, { status: 400 })
  }

  let dupeQuery = db.from("crm_storage_files").select("id", { count: "exact", head: true }).ilike("file_name", escapeIlikePattern(nameCheck.name)).is("deleted_at", null)
  dupeQuery = folderId ? dupeQuery.eq("folder_id", folderId) : dupeQuery.is("folder_id", null)
  const { count: dupeCount } = await dupeQuery
  if (dupeCount && dupeCount > 0) {
    await db.storage.from(CRM_STORAGE_BUCKET).remove([storagePath]).catch(() => {})
    return NextResponse.json({ error: `A file named "${nameCheck.name}" already exists here` }, { status: 409 })
  }

  const { data: row, error } = await db
    .from("crm_storage_files")
    .insert({
      folder_id: folderId,
      file_name: nameCheck.name,
      storage_bucket: CRM_STORAGE_BUCKET,
      storage_path: storagePath,
      mime_type: mimeType,
      file_size: realFileSize,
    })
    .select("id, folder_id, file_name, mime_type, file_size, created_at")
    .maybeSingle()

  if (error || !row) {
    await db.storage.from(CRM_STORAGE_BUCKET).remove([storagePath]).catch(() => {})
    return NextResponse.json({ error: "Failed to record the upload" }, { status: 500 })
  }

  return NextResponse.json({ ok: true, file: row })
}
