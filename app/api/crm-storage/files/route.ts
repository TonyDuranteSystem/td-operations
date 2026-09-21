/**
 * POST /api/crm-storage/files  (multipart/form-data: file, folder_id?)
 *
 * Uploads a file into a folder (or the root if folder_id is omitted). The
 * browser posts bytes straight to our server, which writes to storage with
 * the service role and inserts the index row in one request — no signed
 * URL and no storage credential ever reaches the browser, since every
 * caller here is staff (see requireStaffRoute).
 *
 * Staff-only, end to end.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { validateStorageName } from "@/lib/crm-storage/name-guard"
import { CRM_STORAGE_BUCKET, MAX_UPLOAD_BYTES } from "@/lib/crm-storage/constants"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function POST(req: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const form = await req.formData().catch(() => null)
  if (!form) return NextResponse.json({ error: "Invalid upload" }, { status: 400 })

  const file = form.get("file")
  if (!(file instanceof File)) return NextResponse.json({ error: "No file provided" }, { status: 400 })
  if (file.size === 0) return NextResponse.json({ error: "File is empty" }, { status: 400 })
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: `File exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit` }, { status: 400 })
  }

  const nameCheck = validateStorageName(file.name)
  if (nameCheck.error) return NextResponse.json({ error: nameCheck.error }, { status: 400 })

  const folderIdRaw = form.get("folder_id")
  const folderId = typeof folderIdRaw === "string" && folderIdRaw ? folderIdRaw : null
  if (folderId) {
    const { data: folder } = await db.from("crm_storage_folders").select("id").eq("id", folderId).is("deleted_at", null).maybeSingle()
    if (!folder) return NextResponse.json({ error: "Destination folder not found" }, { status: 404 })
  }

  const storagePath = `${randomUUID()}-${nameCheck.name}`
  const bytes = await file.arrayBuffer()
  const { error: uploadErr } = await db.storage
    .from(CRM_STORAGE_BUCKET)
    .upload(storagePath, bytes, { contentType: file.type || "application/octet-stream", upsert: false })
  if (uploadErr) return NextResponse.json({ error: "Failed to store file" }, { status: 500 })

  const { data: row, error: insertErr } = await db
    .from("crm_storage_files")
    .insert({
      folder_id: folderId,
      file_name: nameCheck.name,
      storage_bucket: CRM_STORAGE_BUCKET,
      storage_path: storagePath,
      mime_type: file.type || null,
      file_size: file.size,
    })
    .select("id, folder_id, file_name, mime_type, file_size, created_at")
    .maybeSingle()

  if (insertErr || !row) {
    await db.storage.from(CRM_STORAGE_BUCKET).remove([storagePath]).catch(() => {})
    return NextResponse.json({ error: "Failed to record the upload" }, { status: 500 })
  }

  return NextResponse.json({ ok: true, file: row })
}
