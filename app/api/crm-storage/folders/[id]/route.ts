/**
 * PATCH  /api/crm-storage/folders/[id]  { name?, parent_id? }
 *   Renames and/or moves a folder (parent_id: null moves it to the root;
 *   omitted leaves it where it is).
 *
 * DELETE /api/crm-storage/folders/[id]
 *   Soft-deletes a folder AND every folder/file nested inside it, at any
 *   depth — deleting a folder that still has real content in it must not
 *   silently orphan that content.
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

async function collectDescendantFolderIds(rootId: string): Promise<string[]> {
  const { data: allFolders } = await db
    .from("crm_storage_folders")
    .select("id, parent_id")
    .is("deleted_at", null)

  const byParent = new Map<string, string[]>()
  for (const row of allFolders ?? []) {
    const key = row.parent_id ?? "__root__"
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)!.push(row.id)
  }

  const collected: string[] = [rootId]
  const queue = [rootId]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const childId of byParent.get(current) ?? []) {
      collected.push(childId)
      queue.push(childId)
    }
  }
  return collected
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const { id } = await params

  const body = await req.json().catch(() => ({}))
  const update: Record<string, unknown> = {}

  const { data: current } = await db.from("crm_storage_folders").select("id, name, parent_id").eq("id", id).is("deleted_at", null).maybeSingle()
  if (!current) return NextResponse.json({ error: "Folder not found" }, { status: 404 })

  if (body.name !== undefined) {
    const nameCheck = validateStorageName(body.name)
    if (nameCheck.error) return NextResponse.json({ error: nameCheck.error }, { status: 400 })
    update.name = nameCheck.name
  }

  if (body.parent_id !== undefined) {
    const newParentId = typeof body.parent_id === "string" && body.parent_id ? body.parent_id : null
    if (newParentId === id) return NextResponse.json({ error: "A folder cannot be moved into itself" }, { status: 400 })
    if (newParentId) {
      const descendants = await collectDescendantFolderIds(id)
      if (descendants.includes(newParentId)) {
        return NextResponse.json({ error: "Cannot move a folder into one of its own subfolders" }, { status: 400 })
      }
    }
    update.parent_id = newParentId
  }

  if (Object.keys(update).length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 })

  const effectiveName = (update.name as string | undefined) ?? current.name
  const effectiveParentId = update.parent_id !== undefined ? (update.parent_id as string | null) : current.parent_id
  let dupeQuery = db.from("crm_storage_folders").select("id", { count: "exact", head: true }).ilike("name", effectiveName).is("deleted_at", null).neq("id", id)
  dupeQuery = effectiveParentId ? dupeQuery.eq("parent_id", effectiveParentId) : dupeQuery.is("parent_id", null)
  const { count: dupeCount } = await dupeQuery
  if (dupeCount && dupeCount > 0) {
    return NextResponse.json({ error: `A folder named "${effectiveName}" already exists here` }, { status: 409 })
  }

  update.updated_at = new Date().toISOString()

  const { data: row, error } = await db
    .from("crm_storage_folders")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select("id, name, parent_id")
    .maybeSingle()

  if (error) return NextResponse.json({ error: "Failed to update the folder" }, { status: 500 })
  if (!row) return NextResponse.json({ error: "Folder not found" }, { status: 404 })
  return NextResponse.json({ ok: true, folder: row })
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const { id } = await params

  const { data: target } = await db.from("crm_storage_folders").select("id").eq("id", id).is("deleted_at", null).maybeSingle()
  if (!target) return NextResponse.json({ error: "Folder not found" }, { status: 404 })

  const folderIds = await collectDescendantFolderIds(id)
  const now = new Date().toISOString()

  const [{ error: foldersErr }, { error: filesErr }] = await Promise.all([
    db.from("crm_storage_folders").update({ deleted_at: now }).in("id", folderIds).is("deleted_at", null),
    db.from("crm_storage_files").update({ deleted_at: now }).in("folder_id", folderIds).is("deleted_at", null),
  ])

  if (foldersErr || filesErr) return NextResponse.json({ error: "Failed to delete the folder" }, { status: 500 })
  return NextResponse.json({ ok: true })
}
