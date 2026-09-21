/**
 * GET  /api/crm-storage/folders?parent_id=<uuid>   (omit parent_id for root)
 *   Lists the subfolders and files directly inside one folder — the
 *   right-hand pane's content list. Not recursive.
 *
 * POST /api/crm-storage/folders  { name, parent_id? }
 *   Creates a new folder. parent_id omitted/null means the new folder is
 *   created at the root.
 *
 * Staff-only, end to end.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { validateStorageName } from "@/lib/crm-storage/name-guard"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

export async function GET(req: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const parentId = req.nextUrl.searchParams.get("parent_id") || null

  let folderQuery = db
    .from("crm_storage_folders")
    .select("id, name, created_at")
    .is("deleted_at", null)
    .order("name", { ascending: true })
  folderQuery = parentId ? folderQuery.eq("parent_id", parentId) : folderQuery.is("parent_id", null)

  let fileQuery = db
    .from("crm_storage_files")
    .select("id, file_name, mime_type, file_size, created_at, updated_at")
    .is("deleted_at", null)
    .order("file_name", { ascending: true })
  fileQuery = parentId ? fileQuery.eq("folder_id", parentId) : fileQuery.is("folder_id", null)

  const [{ data: subfolders, error: folderErr }, { data: files, error: fileErr }] = await Promise.all([folderQuery, fileQuery])
  if (folderErr || fileErr) return NextResponse.json({ error: "Failed to list folder contents" }, { status: 500 })

  return NextResponse.json({ parent_id: parentId, subfolders: subfolders ?? [], files: files ?? [] })
}

export async function POST(req: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const body = await req.json().catch(() => ({}))
  const nameCheck = validateStorageName(body.name)
  if (nameCheck.error) return NextResponse.json({ error: nameCheck.error }, { status: 400 })
  const parentId = typeof body.parent_id === "string" && body.parent_id ? body.parent_id : null

  if (parentId) {
    const { data: parent } = await db
      .from("crm_storage_folders")
      .select("id")
      .eq("id", parentId)
      .is("deleted_at", null)
      .maybeSingle()
    if (!parent) return NextResponse.json({ error: "Parent folder not found" }, { status: 404 })
  }

  let dupeQuery = db.from("crm_storage_folders").select("id", { count: "exact", head: true }).ilike("name", nameCheck.name).is("deleted_at", null)
  dupeQuery = parentId ? dupeQuery.eq("parent_id", parentId) : dupeQuery.is("parent_id", null)
  const { count: dupeCount } = await dupeQuery
  if (dupeCount && dupeCount > 0) {
    return NextResponse.json({ error: `A folder named "${nameCheck.name}" already exists here` }, { status: 409 })
  }

  const { data: row, error } = await db
    .from("crm_storage_folders")
    .insert({ name: nameCheck.name, parent_id: parentId })
    .select("id, name, parent_id, created_at")
    .maybeSingle()

  if (error || !row) return NextResponse.json({ error: "Failed to create the folder" }, { status: 500 })
  return NextResponse.json({ ok: true, folder: row })
}
