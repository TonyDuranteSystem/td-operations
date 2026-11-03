/**
 * Renaming, moving and trashing something that ALREADY exists, from a Mac (dev job 1992a087, 2026-11-03: Antonio, "I can't rename a folder in TD Storage" —
 * the app had refused every rename, move and delete). ONE token-only call (`withDevice`): body { kind, id, action, name?, toParentId? }.
 *
 * The same rules as the Storage page, because the work is done by the CRM's own functions (`renameFolder`, `moveFolder`, `renameStoreFile`,
 * `moveStoreFile`, `trashFile`, `trashFolder`) — a fixed folder, a year folder with files, a name already taken, a locked file are all refused by THEM, in plain words.
 * On top of that, for the Mac: only Business and My files for now (a client's folders are changed in the CRM — what a client sees must not move from Finder);
 * the place the item is in (and, for a move, the place it goes to) must be somewhere this Mac may save (`checkTarget`); a fixed (template) folder is never touched.
 * A trash is the CRM's trash (restorable); nothing is ever erased for good from here.
 */
import type { User } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { getSettings } from "./settings"
import { isClientOwnerKind } from "./save-rules"
import { checkTarget, type SaveAnswer } from "./save"
import { logAppEvent } from "./device-auth"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const EDIT_ACTIONS = ["rename", "move", "trash"] as const
export type EditAction = (typeof EDIT_ACTIONS)[number]
const CHANGE_IN_CRM = "This can only be changed in the CRM."
const refuse = (status: 400 | 404 | 422, code: string, message: string): SaveAnswer => ({ status, body: { error: code, message } })
const plain = (e: unknown, fallback: string): string => (e instanceof Error && e.message ? e.message.replace(/^\[crm-store\] [a-z_]+ failed: /, "").replace(/^store: /, "") : fallback)

export async function editFromMac(p: { user: User; deviceId: string; kind: unknown; id: unknown; action: unknown; name?: unknown; toParentId?: unknown }): Promise<SaveAnswer> {
  const kind = p.kind === "file" || p.kind === "folder" ? p.kind : null
  const action = (EDIT_ACTIONS as readonly string[]).includes(p.action as string) ? (p.action as EditAction) : null
  if (!kind || !action || typeof p.id !== "string" || !UUID.test(p.id)) return refuse(400, "bad_request", "Choose a file or folder and what to do with it.")
  if (action === "rename" && typeof p.name !== "string") return refuse(400, "bad_request", "Enter a name.")
  if (action === "move" && (typeof p.toParentId !== "string" || !UUID.test(p.toParentId))) return refuse(400, "bad_request", "Choose the folder to move it to.")

  // the item, from the database: live, and where it is
  const item = kind === "file"
    ? (await db().from("store_files").select("id, owner_id, folder_id, name, state").eq("id", p.id).maybeSingle())
    : (await db().from("store_folders").select("id, owner_id, parent_id, name, kind, template_slug, trashed_at").eq("id", p.id).maybeSingle())
  if (item.error) throw new Error(`Could not read the ${kind} (${item.error.message}).`)
  const row = item.data as { id: string; owner_id: string; folder_id?: string; parent_id?: string | null; name: string; state?: string; template_slug?: string | null; trashed_at?: string | null } | null
  if (!row || (kind === "file" ? row.state !== "live" : !!row.trashed_at)) return refuse(404, "not_found", "That item was not found.")
  const placeId = kind === "file" ? row.folder_id : row.parent_id
  const ids = { ownerId: row.owner_id, folderId: kind === "folder" ? row.id : placeId ?? null, fileId: kind === "file" ? row.id : null }
  const refused = async (code: string, message: string, status: 404 | 422): Promise<SaveAnswer> => {
    await logAppEvent("app_edit_refused", p.user.id, { deviceId: p.deviceId, action, kind, reason: code }, ids)
    return refuse(status, code, message)
  }
  const { data: owner, error: oErr } = await db().from("store_owners").select("kind").eq("id", row.owner_id).maybeSingle()
  if (oErr) throw new Error(`Could not read the storage (${oErr.message}).`)
  // a client's folders are changed in the CRM (what a client sees must not move from Finder); only Business and My files here
  if (!owner || isClientOwnerKind(owner.kind)) return refused("not_allowed", CHANGE_IN_CRM, 422)
  if (kind === "folder" && (row.template_slug || !placeId)) return refused("not_allowed", "This is one of the fixed folders — it is managed in the CRM.", 422)
  if (!placeId) return refused("not_allowed", CHANGE_IN_CRM, 422)

  const settings = await getSettings()
  const here = await checkTarget({ ownerId: row.owner_id, folderId: placeId }, p.user, settings)
  if (here.ok === false) return refused(here.code, here.message === "That folder is in the trash." ? CHANGE_IN_CRM : here.message, here.code === "not_found" ? 404 : 422)
  if (action === "move") {
    const there = await checkTarget({ ownerId: row.owner_id, folderId: p.toParentId as string }, p.user, settings)   // the same storage, a place a Mac may save
    if (there.ok === false) return refused(there.code, there.message, there.code === "not_found" ? 404 : 422)
  }

  const crm = { id: p.user.id, app_metadata: p.user.app_metadata }
  let body: Record<string, unknown>
  try {
    if (action === "rename") {
      const r = kind === "file" ? await (await import("@/lib/crm-store/file-actions")).renameStoreFile(row.id, p.name as string, p.user.id) : await (await import("@/lib/crm-store/structure")).renameFolder(row.id, p.name as string, p.user.id)
      body = { id: row.id, kind, name: r.name, parentId: placeId }
    } else if (action === "move") {
      if (kind === "file") await (await import("@/lib/crm-store/file-actions")).moveStoreFile(row.id, p.toParentId as string, p.user.id)
      else await (await import("@/lib/crm-store/structure")).moveFolder(row.id, p.toParentId as string, p.user.id)
      body = { id: row.id, kind, name: row.name, parentId: p.toParentId }
    } else {
      const f = await import("@/lib/crm-store/folders")
      if (kind === "file") await f.trashFile(crm, row.id, "trashed from the Mac app")
      else await f.trashFolder(crm, row.id, "trashed from the Mac app")
      body = { id: row.id, kind, name: row.name, parentId: placeId, trashed: true }
    }
  } catch (e) {
    return refused("refused", plain(e, "That could not be done."), 422)
  }
  await logAppEvent(`app_item_${action}`, p.user.id, { deviceId: p.deviceId, kind, name: row.name.slice(0, 120), ...(action === "rename" ? { to: String(body.name).slice(0, 120) } : {}) }, ids)
  return { status: 200, body }
}
