/**
 * CRM Store — "Shared with staff" (Antonio 2026-09-28). Inside the owners' "My files" there is one fixed folder,
 * "Shared with staff". For EACH file in it (or in its sub-folders) the owners tick which staff logins may open and
 * download it. A staff member sees ONLY the files ticked for them — never the rest of My files — and can't change,
 * move or delete them. A file moved out of the folder stops being shared (its ticks are removed). Every share and
 * unshare is logged (store_events "shared" / "unshared").
 */
import { supabaseAdmin } from "@/lib/supabase-admin"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

export interface StaffLogin { userId: string; email: string; name: string }

/** Staff logins that can be ticked: staff roles, not blocked, and not an owner (owners already see everything). */
export async function listStaffLogins(): Promise<StaffLogin[]> {
  const { listAllAuthUsers } = await import("@/lib/auth-admin-helpers")
  const { isStoreStaffUser } = await import("./access")
  const { isOwnerOnly } = await import("@/lib/auth")
  const users = await listAllAuthUsers()
  return users
    .filter((u) => isStoreStaffUser(u) && !isOwnerOnly(u) && !u.banned_until && !!u.email)
    .map((u) => ({ userId: u.id, email: u.email as string, name: (u.user_metadata?.full_name as string | undefined) || (u.email as string).split("@")[0] }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Is this folder "Shared with staff" or inside it? (the nearest fixed folder above it is the staff-share folder) */
export async function isInStaffShare(folderId: string): Promise<boolean> {
  const { effectiveKind } = await import("./structure")
  return (await effectiveKind(folderId)) === "staff_share"
}

interface FileRow { id: string; name: string; state: string; owner_id: string; folder_id: string; store_owners: { kind: string } | null }

async function fileRow(fileId: string): Promise<FileRow | null> {
  const { data, error } = await db().from("store_files").select("id, name, state, owner_id, folder_id, store_owners(kind)").eq("id", fileId).maybeSingle()
  if (error) throw new Error(`Could not read the file (${error.message}).`)
  return data as FileRow | null
}

/** Who a file is shared with (user ids). */
export async function fileShares(fileId: string): Promise<string[]> {
  const { data, error } = await db().from("store_file_shares").select("user_id").eq("file_id", fileId)
  if (error) throw new Error(`Could not read who this file is shared with (${error.message}).`)
  return ((data ?? []) as { user_id: string }[]).map((r) => r.user_id)
}

/** Who each of several files is shared with (one read). */
export async function sharesForFiles(fileIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (let i = 0; i < fileIds.length; i += 200) {
    const { data, error } = await db().from("store_file_shares").select("file_id, user_id").in("file_id", fileIds.slice(i, i + 200))
    if (error) throw new Error(`Could not read who these files are shared with (${error.message}).`)
    for (const r of (data ?? []) as { file_id: string; user_id: string }[]) out.set(r.file_id, [...(out.get(r.file_id) ?? []), r.user_id])
  }
  return out
}

/** Pure: the ticks to add and to remove. */
export function shareDiff(current: string[], wanted: string[]): { add: string[]; remove: string[] } {
  const c = new Set(current), w = new Set(wanted)
  return { add: Array.from(w).filter((x) => !c.has(x)), remove: Array.from(c).filter((x) => !w.has(x)) }
}

/** Set exactly who may open a file in "Shared with staff" (the caller has already passed the owners' area check). */
export async function setFileShares(fileId: string, userIds: string[], actorId: string | null): Promise<{ sharedWith: string[] }> {
  const f = await fileRow(fileId)
  if (!f || f.state !== "live") throw new Error("File not found.")
  if (f.store_owners?.kind !== "private") throw new Error("Only files in My files › Shared with staff can be shared with staff.")
  if (!(await isInStaffShare(f.folder_id))) throw new Error("Move the file into My files › Shared with staff first — only files there can be shared with staff.")
  const allowed = new Set((await listStaffLogins()).map((l) => l.userId))
  const wanted = Array.from(new Set(userIds))
  const bad = wanted.filter((u) => !allowed.has(u))
  if (bad.length) throw new Error("One of the people ticked is not a staff login any more — refresh and try again.")
  const { add, remove } = shareDiff(await fileShares(fileId), wanted)
  // log only what really changed (two owners saving at once: the rows actually written / removed)
  let added: string[] = [], removed: string[] = []
  if (add.length) {
    const { data, error } = await db().from("store_file_shares")
      .upsert(add.map((u) => ({ file_id: fileId, user_id: u, shared_by: actorId })), { onConflict: "file_id,user_id", ignoreDuplicates: true })
      .select("user_id")
    if (error) throw new Error(`The file could not be shared (${error.message}).`)
    added = ((data ?? []) as { user_id: string }[]).map((r) => r.user_id)
  }
  if (remove.length) {
    const { data, error } = await db().from("store_file_shares").delete().eq("file_id", fileId).in("user_id", remove).select("user_id")
    if (error) throw new Error(`The file could not be unshared (${error.message}).`)
    removed = ((data ?? []) as { user_id: string }[]).map((r) => r.user_id)
  }
  const events = [...added.map((u) => ({ event: "shared", user: u })), ...removed.map((u) => ({ event: "unshared", user: u }))]
  if (events.length) {
    const { error } = await db().from("store_events").insert(events.map((e) => ({ event: e.event, actor: actorId, owner_id: f.owner_id, file_id: f.id, folder_id: f.folder_id, name_snapshot: f.name, details: { staff_user: e.user } })))
    if (error) console.error(`[crm-store] share change not logged for ${f.id}: ${error.message}`)
  }
  return { sharedWith: await fileShares(fileId) }
}

/** A staff member may read this file: it is ticked for them AND it is still live and inside "Shared with staff". */
export async function canReadSharedFile(fileId: string, userId: string): Promise<boolean> {
  const { data, error } = await db().from("store_file_shares").select("file_id").eq("file_id", fileId).eq("user_id", userId).maybeSingle()
  if (error || !data) return false
  const f = await fileRow(fileId)
  if (!f || f.state !== "live" || f.store_owners?.kind !== "private") return false
  return isInStaffShare(f.folder_id)
}

/**
 * Ticks survive ONLY a move that stays inside "Shared with staff". A file that leaves it, ENTERS it from outside,
 * or goes to the trash loses every tick — so an old tick can never come back to life (a later move back in, a
 * restore) and a file always starts unshared in Shared with staff. Throws on a database error (the caller says so).
 */
export async function clearShares(fileIds: string[], actorId: string | null, reason: string): Promise<void> {
  if (!fileIds.length) return
  for (let i = 0; i < fileIds.length; i += 200) {
    const part = fileIds.slice(i, i + 200)
    const { data, error } = await db().from("store_file_shares").delete().in("file_id", part).select("file_id, user_id")
    if (error) throw new Error(`The sharing with staff could not be removed (${error.message}) — open the file's "Shared with" and untick everyone.`)
    const byFile = new Map<string, string[]>()
    for (const r of (data ?? []) as { file_id: string; user_id: string }[]) byFile.set(r.file_id, [...(byFile.get(r.file_id) ?? []), r.user_id])
    for (const [id, users] of Array.from(byFile.entries())) {
      const f = await fileRow(id)
      if (f) await db().from("store_events").insert({ event: "unshared", actor: actorId, owner_id: f.owner_id, file_id: f.id, folder_id: f.folder_id, name_snapshot: f.name, details: { reason, staff_users: users } })
    }
  }
}

/** After a move from `wasInside`: keep the ticks only if the file was AND still is inside Shared with staff. */
export async function afterMove(fileIds: string[], wasInside: boolean, actorId: string | null): Promise<void> {
  if (!fileIds.length) return
  const out: string[] = []
  for (const id of fileIds) {
    const f = await fileRow(id)
    const inside = !!f && f.state === "live" && f.store_owners?.kind === "private" && (await isInStaffShare(f.folder_id))
    if (!(wasInside && inside)) out.push(id)
  }
  await clearShares(out, actorId, wasInside ? "moved out of Shared with staff" : "moved into Shared with staff — starts unshared")
}

export interface SharedFile { id: string; name: string; where: string; mimeType: string | null; size: number | null; updatedAt: string; sharedAt: string }

/** What a staff member sees: the files ticked for them, with the folder they sit in under "Shared with staff". */
export async function sharedWithMe(userId: string): Promise<SharedFile[]> {
  const { data, error } = await db().from("store_file_shares").select("file_id, shared_at").eq("user_id", userId)
  if (error) throw new Error(`Could not read the files shared with you (${error.message}).`)
  const rows = (data ?? []) as { file_id: string; shared_at: string }[]
  if (!rows.length) return []
  const at = new Map(rows.map((r) => [r.file_id, r.shared_at]))
  const out: SharedFile[] = []
  for (let i = 0; i < rows.length; i += 200) {
    const { data: files, error: fErr } = await db().from("store_files")
      .select("id, name, state, folder_id, updated_at, store_owners(kind), store_file_versions!store_files_current_version_fk(size_bytes, mime_type)")
      .in("id", rows.slice(i, i + 200).map((r) => r.file_id)).eq("state", "live")
    if (fErr) throw new Error(`Could not read the files shared with you (${fErr.message}).`)
    for (const f of (files ?? []) as Array<{ id: string; name: string; folder_id: string; updated_at: string; store_owners: { kind: string } | null; store_file_versions: { size_bytes: number | null; mime_type: string | null } | null }>) {
      let inside = false
      try { inside = f.store_owners?.kind === "private" && (await isInStaffShare(f.folder_id)) } catch { inside = false }
      if (!inside) continue
      out.push({ id: f.id, name: f.name, where: (await pathUnderShare(f.folder_id)).join(" › "), mimeType: f.store_file_versions?.mime_type ?? null, size: f.store_file_versions?.size_bytes ?? null, updatedAt: f.updated_at, sharedAt: at.get(f.id) ?? f.updated_at })
    }
  }
  return out.sort((a, b) => a.where.localeCompare(b.where) || a.name.localeCompare(b.name))
}

/** Folder names from "Shared with staff" down to this folder. */
async function pathUnderShare(folderId: string): Promise<string[]> {
  const names: string[] = []
  let cur: string | null = folderId
  for (let i = 0; i < 50 && cur; i++) {
    const { data } = await db().from("store_folders").select("name, kind, parent_id").eq("id", cur).maybeSingle()
    if (!data) break
    names.unshift(data.name)
    if (data.kind === "staff_share") break
    cur = data.parent_id
  }
  return names
}
