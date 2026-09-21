/**
 * GET    /api/crm-storage/favorites
 *   Lists the CURRENT staff member's starred folders/files. Favorites are
 *   per-user by design — a personal shortcut list, not a shared setting.
 *
 * POST   /api/crm-storage/favorites  { folder_id? , file_id? }  (exactly one)
 *   Stars a folder or file for the current staff member. Idempotent.
 *
 * DELETE /api/crm-storage/favorites  { folder_id? , file_id? }  (exactly one)
 *   Unstars it.
 *
 * Staff-only, end to end.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { createClient } from "@/lib/supabase/server"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

async function currentUserId(): Promise<string | null> {
  const supabase = createClient()
  const { data } = await supabase.auth.getUser()
  return data.user?.id ?? null
}

function parseTarget(body: { folder_id?: unknown; file_id?: unknown }): { folderId: string | null; fileId: string | null } | null {
  const folderId = typeof body.folder_id === "string" && body.folder_id ? body.folder_id : null
  const fileId = typeof body.file_id === "string" && body.file_id ? body.file_id : null
  if ((folderId && fileId) || (!folderId && !fileId)) return null
  return { folderId, fileId }
}

export async function GET() {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const userId = await currentUserId()
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })

  const { data, error } = await db
    .from("crm_storage_favorites")
    .select("id, folder_id, file_id")
    .eq("user_id", userId)
  if (error) return NextResponse.json({ error: "Failed to load favorites" }, { status: 500 })
  return NextResponse.json({ favorites: data ?? [] })
}

export async function POST(req: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const userId = await currentUserId()
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const target = parseTarget(body)
  if (!target) return NextResponse.json({ error: "Pass exactly one of folder_id or file_id" }, { status: 400 })

  // Not a plain upsert: the uniqueness here lives on PARTIAL unique
  // indexes (folder_id set XOR file_id set), and Postgres' ON CONFLICT
  // inference can't match a partial index from a bare column list — it
  // needs the index's own WHERE predicate, which supabase-js has no way
  // to pass through `onConflict`. Check-then-insert avoids that class of
  // failure entirely (same pattern used for idempotent folder creation).
  let existsQuery = db.from("crm_storage_favorites").select("id", { count: "exact", head: true }).eq("user_id", userId)
  existsQuery = target.folderId ? existsQuery.eq("folder_id", target.folderId) : existsQuery.eq("file_id", target.fileId)
  const { count } = await existsQuery
  if (count && count > 0) return NextResponse.json({ ok: true, alreadyStarred: true })

  const { error } = await db
    .from("crm_storage_favorites")
    .insert({ user_id: userId, folder_id: target.folderId, file_id: target.fileId })
  if (error) return NextResponse.json({ error: "Failed to star" }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  const userId = await currentUserId()
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const target = parseTarget(body)
  if (!target) return NextResponse.json({ error: "Pass exactly one of folder_id or file_id" }, { status: 400 })

  let query = db.from("crm_storage_favorites").delete().eq("user_id", userId)
  query = target.folderId ? query.eq("folder_id", target.folderId) : query.eq("file_id", target.fileId)
  const { error } = await query
  if (error) return NextResponse.json({ error: "Failed to unstar" }, { status: 500 })
  return NextResponse.json({ ok: true })
}
