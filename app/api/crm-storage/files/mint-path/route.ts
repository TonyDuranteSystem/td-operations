/**
 * POST /api/crm-storage/files/mint-path  { file_name, folder_id? }
 *
 * First step of a large-file upload: validates the name and destination
 * BEFORE any bytes move, and hands back a unique storage location. A
 * multi-GB file (e.g. a Zoom recording) uploads directly from the browser
 * to storage afterward (see .../files/register and
 * lib/crm-storage/resumable-upload-client.ts) — nothing this big should
 * pass through our own server, and nobody should wait for a multi-GB
 * transfer only to be told the name collided.
 *
 * Staff-only.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { validateStorageName } from "@/lib/crm-storage/name-guard"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function POST(req: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const body = await req.json().catch(() => ({}))
  const nameCheck = validateStorageName(body.file_name)
  if (nameCheck.error) return NextResponse.json({ error: nameCheck.error }, { status: 400 })

  const folderId = typeof body.folder_id === "string" && body.folder_id ? body.folder_id : null
  if (folderId) {
    const { data: folder } = await db.from("crm_storage_folders").select("id").eq("id", folderId).is("deleted_at", null).maybeSingle()
    if (!folder) return NextResponse.json({ error: "Destination folder not found" }, { status: 404 })
  }

  let dupeQuery = db.from("crm_storage_files").select("id", { count: "exact", head: true }).ilike("file_name", nameCheck.name).is("deleted_at", null)
  dupeQuery = folderId ? dupeQuery.eq("folder_id", folderId) : dupeQuery.is("folder_id", null)
  const { count: dupeCount } = await dupeQuery
  if (dupeCount && dupeCount > 0) {
    return NextResponse.json({ error: `A file named "${nameCheck.name}" already exists here` }, { status: 409 })
  }

  const path = `${randomUUID()}-${nameCheck.name}`
  return NextResponse.json({ path, file_name: nameCheck.name })
}
