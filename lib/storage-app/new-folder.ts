/**
 * Making a NEW folder from a Mac (dev job 1992a087, 2026-11-03: Antonio pasted 17 Zoom-call folders in Finder and none reached the CRM,
 * because the app refused every folder). ONE call, token-only (`withDevice`): body { ownerId, parentId, name }.
 *
 * Same rules as saving a file: the destination must be somewhere this Mac may save (`checkTarget`: Business and My files, never a storage's top
 * folder, never "2. Contacts", never "Shared with staff", a client storage only when the settings allow it, this login must be able to open it).
 * The folder is made (or REUSED, when a folder of that name is already there) by the CRM's own `ensureFolderPath` — the same writer as a folder dragged
 * into the Storage page — so pasting the same folder twice, or a retry after a lost answer, never makes a second folder. Nothing is ever renamed,
 * moved or deleted. The answer says whether the folder was made now (`created`) or already existed.
 */
import type { User } from "@supabase/supabase-js"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { getSettings } from "./settings"
import { isJunkName } from "./save-rules"
import { checkTarget, type SaveAnswer } from "./save"
import { logAppEvent } from "./device-auth"
import { cleanFolderName } from "@/lib/crm-store/names"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const refuse = (status: 400 | 404 | 422, code: string, message: string): SaveAnswer => ({ status, body: { error: code, message } })

export async function createFolderFromMac(p: { user: User; deviceId: string; ownerId: unknown; parentId: unknown; name: unknown }): Promise<SaveAnswer> {
  if (typeof p.ownerId !== "string" || typeof p.parentId !== "string" || !UUID.test(p.ownerId) || !UUID.test(p.parentId) || typeof p.name !== "string") {
    return refuse(400, "bad_request", "Choose a folder and a name.")
  }
  let name: string
  try { name = cleanFolderName(p.name) } catch (e) { return refuse(400, "bad_name", e instanceof Error ? e.message : "That folder name can't be used.") }
  const ids = { ownerId: p.ownerId, folderId: p.parentId }
  const refused = async (code: string, message: string, status: 404 | 422): Promise<SaveAnswer> => {
    await logAppEvent("app_folder_refused", p.user.id, { deviceId: p.deviceId, reason: code, name: name.slice(0, 120) }, ids)
    return refuse(status, code, message)
  }
  // system junk (".DS_Store" folders and the like) is never made, same as for files
  if (isJunkName(name)) return refused("ignored", "System files and folders are not saved.", 422)
  const target = await checkTarget({ ownerId: p.ownerId, folderId: p.parentId }, p.user, await getSettings())
  if (target.ok === false) return refused(target.code, target.message, target.code === "not_found" ? 404 : 422)
  const { storeNameKey } = await import("@/lib/crm-store/rules")
  const taken = async (): Promise<string | null> => {
    const { data, error } = await db().from("store_folders").select("id").eq("owner_id", p.ownerId).eq("parent_id", p.parentId).eq("name_key", storeNameKey(name)).is("trashed_at", null).maybeSingle()
    if (error) throw new Error(`Could not check the folder (${error.message}).`)
    return (data?.id as string | undefined) ?? null
  }
  const before = await taken()
  const { ensureFolderPath } = await import("@/lib/crm-store/extras")
  let made: { id: string }
  try { made = await ensureFolderPath(p.parentId, [name], p.user.id) }
  catch (e) { return refuse(422, "not_allowed", e instanceof Error ? e.message : "The folder could not be made.") }
  if (!before) await logAppEvent("app_folder_created", p.user.id, { deviceId: p.deviceId, name: name.slice(0, 120) }, { ownerId: p.ownerId, folderId: made.id })
  return { status: 200, body: { folderId: made.id, ownerId: p.ownerId, name, created: !before } }
}
