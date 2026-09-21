/**
 * PATCH  /api/crm-storage/files/[id]  { file_name?, folder_id? }
 *   Renames and/or moves a file (folder_id: null moves it to the root).
 *
 * DELETE /api/crm-storage/files/[id]
 *   Soft-deletes a file.
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

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const { id } = await params

  const body = await req.json().catch(() => ({}))
  const update: Record<string, unknown> = {}

  if (body.file_name !== undefined) {
    const nameCheck = validateStorageName(body.file_name)
    if (nameCheck.error) return NextResponse.json({ error: nameCheck.error }, { status: 400 })
    update.file_name = nameCheck.name
  }

  if (body.folder_id !== undefined) {
    const newFolderId = typeof body.folder_id === "string" && body.folder_id ? body.folder_id : null
    if (newFolderId) {
      const { data: folder } = await db.from("crm_storage_folders").select("id").eq("id", newFolderId).is("deleted_at", null).maybeSingle()
      if (!folder) return NextResponse.json({ error: "Destination folder not found" }, { status: 404 })
    }
    update.folder_id = newFolderId
  }

  if (Object.keys(update).length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 })
  update.updated_at = new Date().toISOString()

  const { data: row, error } = await db
    .from("crm_storage_files")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select("id, file_name, folder_id")
    .maybeSingle()

  if (error) return NextResponse.json({ error: "Failed to update the file" }, { status: 500 })
  if (!row) return NextResponse.json({ error: "File not found" }, { status: 404 })
  return NextResponse.json({ ok: true, file: row })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const { id } = await params

  const { data: row, error } = await db
    .from("crm_storage_files")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle()

  if (error) return NextResponse.json({ error: "Failed to delete the file" }, { status: 500 })
  if (!row) return NextResponse.json({ error: "File not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}
