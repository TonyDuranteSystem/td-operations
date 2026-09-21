/**
 * GET /api/crm-storage/search?q=<text>&type=<all|folders|files>
 *
 * Whole-tree filename/folder-name search — not scoped to the folder
 * currently open. Each hit includes its folder path so staff know where
 * to jump. Deliberately simple (substring match, no filters beyond the
 * type toggle) per the frozen build plan.
 *
 * Staff-only, end to end.
 */

export const dynamic = "force-dynamic"

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

async function buildFolderPathMap(): Promise<Map<string, string>> {
  const { data: folders } = await db.from("crm_storage_folders").select("id, parent_id, name").is("deleted_at", null)
  const byId = new Map<string, { parent_id: string | null; name: string }>()
  for (const row of folders ?? []) byId.set(row.id, { parent_id: row.parent_id, name: row.name })

  const pathCache = new Map<string, string>()
  function pathFor(id: string): string {
    if (pathCache.has(id)) return pathCache.get(id)!
    const node = byId.get(id)
    if (!node) return ""
    const parentPath = node.parent_id ? pathFor(node.parent_id) : ""
    const full = parentPath ? `${parentPath} / ${node.name}` : node.name
    pathCache.set(id, full)
    return full
  }
  for (const id of Array.from(byId.keys())) pathFor(id)
  return pathCache
}

export async function GET(req: NextRequest) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const q = (req.nextUrl.searchParams.get("q") || "").trim()
  const type = req.nextUrl.searchParams.get("type") || "all"
  if (!q) return NextResponse.json({ folders: [], files: [] })

  const folderPaths = await buildFolderPathMap()

  const [foldersResult, filesResult] = await Promise.all([
    type === "files"
      ? Promise.resolve({ data: [] })
      : db.from("crm_storage_folders").select("id, parent_id, name").is("deleted_at", null).ilike("name", `%${q}%`).limit(50),
    type === "folders"
      ? Promise.resolve({ data: [] })
      : db.from("crm_storage_files").select("id, folder_id, file_name, mime_type, file_size").is("deleted_at", null).ilike("file_name", `%${q}%`).limit(50),
  ])

  const folders = (foldersResult.data ?? []).map((f: { id: string; parent_id: string | null; name: string }) => ({
    id: f.id,
    name: f.name,
    path: f.parent_id ? folderPaths.get(f.parent_id) ?? "" : "",
  }))
  const files = (filesResult.data ?? []).map((f: { id: string; folder_id: string | null; file_name: string; mime_type: string | null; file_size: number | null }) => ({
    id: f.id,
    file_name: f.file_name,
    mime_type: f.mime_type,
    file_size: f.file_size,
    folder_id: f.folder_id,
    path: f.folder_id ? folderPaths.get(f.folder_id) ?? "" : "",
  }))

  return NextResponse.json({ folders, files })
}
