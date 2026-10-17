/**
 * What the Mac app is shown (dev job 1992a087). Reuses the Storage page's own functions — nothing about names, groups or
 * permissions is re-decided here. Two differences by design: LIVE storages only (a hidden study copy is not shown), and each
 * file says whether a Mac may download it (sensitive documents may not — see sensitive.ts).
 */
import type { User } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isOwnerOnly } from "@/lib/auth"
import { isSensitiveForDevice } from "./sensitive"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

/** ids of the storages that are LIVE (study_only = false), read in pages. */
export async function liveOwnerIds(): Promise<Set<string>> {
  const out = new Set<string>()
  for (let from = 0; from < 100_000; from += 1000) {
    const { data, error } = await db().from("store_owners").select("id").eq("study_only", false).order("id").range(from, from + 999)
    if (error) throw new Error(`Could not read the storages (${error.message}).`)
    for (const r of (data ?? []) as { id: string }[]) out.add(r.id)
    if ((data ?? []).length < 1000) break
  }
  return out
}

export async function isLiveOwner(ownerId: string): Promise<boolean> {
  const { data, error } = await db().from("store_owners").select("study_only").eq("id", ownerId).maybeSingle()
  if (error) throw new Error(`Could not read the storage (${error.message}).`)
  return !!data && data.study_only === false
}

/** The Storage page's left side (groups → storages), minus hidden study copies and empty groups. */
export async function appNavigation(user: User) {
  const { navigation } = await import("@/lib/crm-store/structure")
  const groups = await navigation({ id: user.id, email: user.email }, isOwnerOnly(user))
  const live = await liveOwnerIds()
  return groups.map((g) => ({ ...g, owners: g.owners.filter((o) => live.has(o.id)) })).filter((g) => g.owners.length > 0)
}

/** One folder (or an owner's top folder when folderId is null): sub-folders and live files with the download flag. */
export async function appFolder(ownerId: string, folderId: string | null) {
  const { folderContents } = await import("@/lib/crm-store/browse")
  const c = await folderContents(ownerId, folderId)
  if (c.folder?.trashed) return null          // a trashed folder is not shown (the Storage page lists it only in the trash view)
  return {
    owner: c.owner,
    folder: c.folder ? { id: c.folder.id, name: c.folder.name, kind: c.folder.kind, locked: !!c.folder.locked } : null,
    folders: c.folders.filter((f) => f.kind !== "contacts").map((f) => ({ id: f.id, name: f.name, kind: f.kind, locked: !!f.locked })),
    files: c.files.filter((f) => f.state === "live").map((f) => ({
      id: f.id, name: f.name, size: f.size, mimeType: f.mimeType, updatedAt: f.updatedAt,
      downloadable: !isSensitiveForDevice({ documentType: f.documentType, ownerKind: f.inPersonStorage ? "person" : c.owner.kind }),
    })),
  }
}

export interface AppItem {
  kind: "file" | "folder"; id: string; ownerId: string; parentId: string | null; name: string
  locked?: boolean; size?: number | null; mimeType?: string | null; updatedAt?: string; downloadable?: boolean
}

/**
 * One file or folder by id, with its PARENT — what Finder asks when it needs an item it only knows by id. `parentId` is null for a
 * storage's top folder (its parent, for Finder, is the storage itself). null = missing, trashed or purged.
 */
export async function appItem(kind: "file" | "folder", id: string): Promise<AppItem | null> {
  if (kind === "folder") {
    const { data, error } = await db().from("store_folders").select("id, owner_id, parent_id, name, template_slug, trashed_at").eq("id", id).maybeSingle()
    if (error) throw new Error(`Could not read the folder (${error.message}).`)
    if (!data || data.trashed_at) return null
    return { kind, id: data.id, ownerId: data.owner_id, parentId: data.parent_id ?? null, name: data.name, locked: data.template_slug !== null || data.parent_id === null }
  }
  const { data, error } = await db().from("store_files")
    .select("id, owner_id, folder_id, name, state, document_type, updated_at, store_owners(kind), store_file_versions!store_files_current_version_fk(size_bytes, mime_type)").eq("id", id).maybeSingle()
  if (error) throw new Error(`Could not read the file (${error.message}).`)
  if (!data || data.state !== "live") return null
  const v = (Array.isArray(data.store_file_versions) ? data.store_file_versions[0] : data.store_file_versions) as { size_bytes: number | null; mime_type: string | null } | null
  const ownerKind = (Array.isArray(data.store_owners) ? data.store_owners[0] : data.store_owners)?.kind as string | undefined
  return {
    kind, id: data.id, ownerId: data.owner_id, parentId: data.folder_id, name: data.name, size: v?.size_bytes ?? null, mimeType: v?.mime_type ?? null,
    updatedAt: data.updated_at, downloadable: !isSensitiveForDevice({ documentType: data.document_type, ownerKind }),
  }
}
