/**
 * CRM Store — read-only staff browser of the NEW store (job 685467b5).
 *
 * Backs the "New storage" tab on the Storage page so staff can SEE what the new store holds (owners →
 * folders → files) while every flow still lists documents from the old documents list. View only: no
 * upload / rename / move / delete here (those come with the Stage-1 screens).
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

// store_* tables are not in the generated types until they reach production.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

export interface BrowseOwner {
  id: string
  kind: "company" | "person" | "formation" | "unfiled"
  label: string
  status: string | null // "being formed" / "archived" / null
  fileCount: number
}

export interface BrowseFolder { id: string; name: string; kind: string; trashed: boolean }

export interface BrowseFile {
  id: string
  name: string
  documentType: string | null
  state: "live" | "trashed" | "purged" | string
  published: boolean
  clientVisible: boolean
  staffOnly: boolean
  personal: boolean
  versions: number
  size: number | null
  mimeType: string | null
  updatedAt: string
}

/** Pure: the label shown for an owner (unit-tested). */
export function ownerLabel(o: { kind: string; company?: string | null; person?: string | null; root?: string | null }): string {
  if (o.kind === "company") return o.company || o.root || "Company"
  if (o.kind === "person") return o.person || o.root || "Person"
  if (o.kind === "formation") return o.root || "Company being formed"
  return "Unfiled"
}

/** Pure: the owner's status badge (unit-tested). */
export function ownerStatus(lifecycleOverride: string | null | undefined): string | null {
  if (lifecycleOverride === "in_formation") return "being formed"
  if (lifecycleOverride === "archived") return "archived"
  return null
}

export async function listOwners(): Promise<BrowseOwner[]> {
  const { data: owners, error } = await db().from("store_owners")
    .select("id, kind, account_id, contact_id, lifecycle_override, accounts(company_name), contacts(full_name)")
    .order("created_at", { ascending: false }).limit(500)
  if (error) throw new Error(`store browse: ${error.message}`)
  const ids = (owners ?? []).map((o: { id: string }) => o.id)
  const roots = new Map<string, string>()
  const counts = new Map<string, number>()
  if (ids.length > 0) {
    const { data: rs } = await db().from("store_folders").select("owner_id, name").in("owner_id", ids).is("parent_id", null)
    for (const r of rs ?? []) roots.set(r.owner_id as string, r.name as string)
    const { data: fs } = await db().from("store_files").select("owner_id").in("owner_id", ids).eq("state", "live")
    for (const f of fs ?? []) counts.set(f.owner_id as string, (counts.get(f.owner_id as string) ?? 0) + 1)
  }
  return (owners ?? []).map((o: { id: string; kind: BrowseOwner["kind"]; lifecycle_override: string | null; accounts: { company_name: string } | null; contacts: { full_name: string } | null }) => ({
    id: o.id,
    kind: o.kind,
    label: ownerLabel({ kind: o.kind, company: o.accounts?.company_name, person: o.contacts?.full_name, root: roots.get(o.id) }),
    status: ownerStatus(o.lifecycle_override),
    fileCount: counts.get(o.id) ?? 0,
  }))
}

/** A folder's children (or the owner's root when folderId is null) + its files, trashed ones included. */
export async function folderContents(ownerId: string, folderId: string | null): Promise<{ folder: BrowseFolder | null; path: BrowseFolder[]; folders: BrowseFolder[]; files: BrowseFile[] }> {
  let current: BrowseFolder | null = null
  if (folderId) {
    const { data } = await db().from("store_folders").select("id, name, kind, owner_id, trashed_at").eq("id", folderId).maybeSingle()
    if (!data || data.owner_id !== ownerId) throw new Error("store browse: folder not found for this owner")
    current = { id: data.id, name: data.name, kind: data.kind, trashed: !!data.trashed_at }
  } else {
    const { data } = await db().from("store_folders").select("id, name, kind, trashed_at").eq("owner_id", ownerId).is("parent_id", null).maybeSingle()
    if (data) current = { id: data.id, name: data.name, kind: data.kind, trashed: !!data.trashed_at }
  }
  if (!current) return { folder: null, path: [], folders: [], files: [] }

  // breadcrumb (bounded walk up)
  const path: BrowseFolder[] = []
  let walk: string | null = current.id
  for (let i = 0; i < 20 && walk; i++) {
    const { data } = await db().from("store_folders").select("id, name, kind, parent_id, trashed_at").eq("id", walk).maybeSingle()
    if (!data) break
    path.unshift({ id: data.id, name: data.name, kind: data.kind, trashed: !!data.trashed_at })
    walk = data.parent_id
  }

  const { data: subs } = await db().from("store_folders").select("id, name, kind, trashed_at").eq("parent_id", current.id).order("name")
  const { data: fs, error } = await db().from("store_files")
    .select("id, name, document_type, state, published, updated_at, store_file_versions!store_files_current_version_fk(size_bytes, mime_type)")
    .eq("folder_id", current.id).neq("state", "purged").order("name")
  if (error) throw new Error(`store browse: ${error.message}`)
  const files: BrowseFile[] = []
  for (const f of fs ?? []) {
    const [{ data: vis }, { data: pers }, { data: so }, { count }] = await Promise.all([
      db().rpc("store_file_client_visible", { p_file_id: f.id }),
      db().rpc("store_file_is_personal", { p_file_id: f.id }),
      db().rpc("store_type_staff_only", { p_document_type: f.document_type }),
      db().from("store_file_versions").select("id", { count: "exact", head: true }).eq("file_id", f.id),
    ])
    const v = f.store_file_versions as { size_bytes: number | null; mime_type: string | null } | null
    files.push({
      id: f.id, name: f.name, documentType: f.document_type, state: f.state, published: !!f.published,
      clientVisible: vis === true, staffOnly: so === true, personal: pers === true, versions: count ?? 0,
      size: v?.size_bytes ?? null, mimeType: v?.mime_type ?? null, updatedAt: f.updated_at,
    })
  }
  return {
    folder: current,
    path,
    folders: (subs ?? []).map((s: { id: string; name: string; kind: string; trashed_at: string | null }) => ({ id: s.id, name: s.name, kind: s.kind, trashed: !!s.trashed_at })),
    files,
  }
}

/** Current version bytes of a file for staff viewing — trashed files too (staff can look inside the trash). */
export async function readFileForStaff(fileId: string): Promise<{ bytes: Buffer; mimeType: string | null; name: string }> {
  const { data: f, error } = await db().from("store_files")
    .select("name, state, store_file_versions!store_files_current_version_fk(storage_bucket, storage_path, mime_type)")
    .eq("id", fileId).maybeSingle()
  if (error || !f || f.state === "purged") throw new Error("store browse: file not available")
  const v = f.store_file_versions as { storage_bucket: string; storage_path: string; mime_type: string | null } | null
  if (!v) throw new Error("store browse: file has no content")
  const { data, error: dl } = await db().storage.from(v.storage_bucket).download(v.storage_path)
  if (dl || !data) throw new Error("store browse: content could not be read")
  return { bytes: Buffer.from(await data.arrayBuffer()), mimeType: v.mime_type ?? data.type ?? null, name: f.name }
}
