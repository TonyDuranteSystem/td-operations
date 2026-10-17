/**
 * Saving a NEW file from a Mac (dev job 1992a087, phase P3 step A). Two steps, both token-only (`withDevice`):
 *   1. `createSaveSlot` — checks the destination and the name, counts the upload against the Mac's hourly limit, and hands back a
 *      single-use signed upload address (the bytes go straight to storage, not through a CRM function);
 *   2. `saveFromSlot` — checks everything AGAIN, registers the staged file through the CRM's one writer (`registerStagedUpload`), HIDDEN
 *      from clients (`published:false`), and writes the audit row. Saving the same file twice (a retry after a lost answer) returns the
 *      same file — never a second copy. A file whose name is already taken in the folder is REFUSED (the Mac never makes a new version or
 *      overwrites); the rare race that slips past is stored with the writer's " (2)" and the real name is returned.
 * Step A saves only into Business and My files. Never visible to a client: those areas have no client.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import type { User } from "@supabase/supabase-js"
import { logAppEvent } from "./device-auth"
import { checkDestination, checkNewFile, saveCallerKey, isItemKey, writeLimitBytes, MAX_SAVE_BYTES, type SaveRefusal } from "./save-rules"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

export type SaveStatus = 200 | 400 | 404 | 409 | 413 | 422 | 429
export interface SaveAnswer { status: SaveStatus; body: Record<string, unknown> }
const refuse = (status: SaveStatus, code: string, message: string): SaveAnswer => ({ status, body: { error: code, message } })
const STATUS_OF: Record<string, SaveStatus> = { not_found: 404, not_allowed: 422, too_big: 413, bad_name: 400, ignored: 422, exists: 409 }
const fromRefusal = (r: Extract<SaveRefusal, { ok: false }>): SaveAnswer => refuse(STATUS_OF[r.code] ?? 422, r.code, r.message)

interface Target { ownerId: string; folderId: string }

/** The destination, from the database: live storage, live folder of THAT storage, allowed area, this login may open it. */
async function checkTarget(t: Target, user: User): Promise<SaveRefusal> {
  const { data: folder, error } = await db().from("store_folders").select("id, owner_id, kind, trashed_at").eq("id", t.folderId).maybeSingle()
  if (error) throw new Error(`Could not read the folder (${error.message}).`)
  if (!folder || folder.owner_id !== t.ownerId) return { ok: false, code: "not_found", message: "Folder not found." }
  const { data: owner, error: oErr } = await db().from("store_owners").select("kind, study_only").eq("id", t.ownerId).maybeSingle()
  if (oErr) throw new Error(`Could not read the storage (${oErr.message}).`)
  if (!owner || owner.study_only !== false) return { ok: false, code: "not_found", message: "Folder not found." }
  const { isInStaffShare } = await import("@/lib/crm-store/staff-share")
  const rule = checkDestination({ ownerKind: owner.kind, folderKind: folder.kind, inStaffShare: await isInStaffShare(t.folderId), folderTrashed: !!folder.trashed_at })
  if (!rule.ok) return rule
  const { denyUnlessAreaAccess, denyUnlessStorePilotEnv } = await import("@/app/api/crm-store/browse/_auth")
  const noAccess = (await denyUnlessAreaAccess({ ownerId: t.ownerId, folderId: t.folderId }, { user })) ?? (await denyUnlessStorePilotEnv({ ownerId: t.ownerId, folderId: t.folderId, user }))
  if (noAccess) return { ok: false, code: "not_found", message: "Folder not found." }
  return { ok: true }
}

/** The name the file will really have (an iPhone HEIC photo is stored as a JPEG) — refuse a name that is already taken in the folder. */
async function checkNameFree(folderId: string, cleanName: string, mimeType: string | null): Promise<SaveRefusal> {
  const { storeNameKey } = await import("@/lib/crm-store/rules")
  const heic = await import("@/lib/image-heic")
  const finalName = heic.isHeicByNameOrType(cleanName, mimeType) ? heic.jpegNameFor(cleanName) : cleanName
  const { data, error } = await db().from("store_files").select("id, state").eq("folder_id", folderId).eq("name_key", storeNameKey(finalName)).neq("state", "purged")
  if (error) throw new Error(`Could not check the folder (${error.message}).`)
  // a file in the trash has no name key (the trash frees the name), so only live files can clash
  if ((data ?? []).length > 0) return { ok: false, code: "exists", message: "A file with this name is already in this folder. Open the CRM to replace it." }
  return { ok: true }
}

async function existingByKey(callerKey: string): Promise<{ id: string; owner_id: string; name: string } | null> {
  const { data, error } = await db().from("store_files").select("id, owner_id, name").eq("caller_key", callerKey).eq("state", "live").maybeSingle()
  if (error) throw new Error(`Could not check earlier saves (${error.message}).`)
  return data ?? null
}

export async function createSaveSlot(p: { user: User; deviceId: string; ownerId: unknown; folderId: unknown; name: unknown; size: unknown; mimeType: unknown; itemKey: unknown }): Promise<SaveAnswer> {
  if (typeof p.ownerId !== "string" || typeof p.folderId !== "string" || !isItemKey(p.itemKey)) return refuse(400, "bad_request", "Choose a folder and a file.")
  const ids = { ownerId: p.ownerId, folderId: p.folderId }
  const refused = async (code: string, message: string, status: SaveStatus): Promise<SaveAnswer> => {
    await logAppEvent("app_save_refused", p.user.id, { deviceId: p.deviceId, reason: code, name: typeof p.name === "string" ? p.name.slice(0, 120) : null }, ids)
    return refuse(status, code, message)
  }
  const callerKey = saveCallerKey(p.deviceId, p.itemKey)
  const earlier = await existingByKey(callerKey)
  if (earlier) return { status: 200, body: { alreadySaved: true, fileId: earlier.id, ownerId: earlier.owner_id, name: earlier.name } }
  const file = checkNewFile({ name: p.name, size: p.size })
  if (!file.ok) return refused(file.code, file.message, STATUS_OF[file.code] ?? 422)
  const mimeType = typeof p.mimeType === "string" && p.mimeType ? p.mimeType.slice(0, 200) : null
  const target = await checkTarget({ ownerId: p.ownerId, folderId: p.folderId }, p.user)
  if (!target.ok) return refused(target.code, target.message, STATUS_OF[target.code] ?? 422)
  const free = await checkNameFree(p.folderId, file.cleanName!, mimeType)
  if (!free.ok) return refused(free.code, free.message, STATUS_OF[free.code] ?? 409)
  // the hourly upload limit: counted and audited in ONE database step; a database error = no slot (fail closed)
  const { data: reserve, error: rErr } = await db().rpc("storage_app_reserve_write", {
    p_device: p.deviceId, p_user: p.user.id, p_owner: p.ownerId, p_name: file.cleanName, p_caller_key: callerKey, p_size: p.size as number, p_limit: writeLimitBytes(),
  })
  if (rErr) throw new Error(`Could not check the upload limit (${rErr.message}).`)
  if (!(reserve as { allowed?: boolean } | null)?.allowed) return refuse(429, "upload_limit", "This Mac has uploaded a lot in the last hour. Try again later, or add the files in the CRM.")
  const { createServerUploadIntent, STORE_STAGING_BUCKET } = await import("@/lib/crm-store/writer")
  // a retry for the same file reuses its open slot (a fresh address for it), never a second slot
  const { data: open } = await db().from("store_upload_intents").select("id, staging_path").eq("caller_key", callerKey).eq("created_by", p.user.id).is("consumed_at", null).gt("expires_at", new Date().toISOString()).limit(1).maybeSingle()
  let intentId = open?.id as string | undefined
  let stagingPath = open?.staging_path as string | undefined
  if (!intentId) {
    const i = await createServerUploadIntent({ ownerId: p.ownerId, folderId: p.folderId, fileName: file.cleanName!, mimeType, callerKey, actor: p.user.id })
    intentId = i.intentId; stagingPath = i.stagingPath
  }
  const { data: signed, error: sErr } = await supabaseAdmin.storage.from(STORE_STAGING_BUCKET).createSignedUploadUrl(stagingPath!)
  if (sErr || !signed?.signedUrl) throw new Error(`Could not prepare the upload (${sErr?.message ?? "no address"}).`)
  return { status: 200, body: { intentId, uploadUrl: signed.signedUrl, maxBytes: MAX_SAVE_BYTES } }
}

async function giveBackReservation(p: { user: User; deviceId: string; callerKey: string; size: number }) {
  await logAppEvent("app_upload_refunded", p.user.id, { deviceId: p.deviceId, callerKey: p.callerKey, size: Math.max(p.size, 1048576) })
}

export async function saveFromSlot(p: { user: User; deviceId: string; intentId: unknown; itemKey: unknown }): Promise<SaveAnswer> {
  if (typeof p.intentId !== "string" || !isItemKey(p.itemKey)) return refuse(400, "bad_request", "The upload is not complete.")
  const callerKey = saveCallerKey(p.deviceId, p.itemKey)
  const earlier = await existingByKey(callerKey)
  if (earlier) return { status: 200, body: { fileId: earlier.id, ownerId: earlier.owner_id, name: earlier.name, repeated: true } }
  const { data: slot, error } = await db().from("store_upload_intents").select("id, owner_id, folder_id, file_name, mime_type, caller_key, created_by, consumed_at, expires_at, staging_path").eq("id", p.intentId).maybeSingle()
  if (error) throw new Error(`Could not read the upload slot (${error.message}).`)
  if (!slot || slot.created_by !== p.user.id || slot.caller_key !== callerKey) return refuse(404, "not_found", "This upload was not found. Try saving again.")
  if (slot.consumed_at || new Date(slot.expires_at).getTime() < Date.now()) return refuse(409, "slot_closed", "This upload is no longer open. Try saving again.")
  const ids = { ownerId: slot.owner_id as string, folderId: slot.folder_id as string }
  const { storedSize, registerStagedUpload, STORE_STAGING_BUCKET } = await import("@/lib/crm-store/writer")
  let size: number
  try { size = await storedSize(STORE_STAGING_BUCKET, slot.staging_path as string) } catch { return refuse(409, "not_uploaded", "The file did not arrive. Try saving again.") }
  const back = (extra: Record<string, unknown>) => giveBackReservation({ user: p.user, deviceId: p.deviceId, callerKey, size }).then(() => extra)
  if (size > MAX_SAVE_BYTES) { await back({}); return refuse(413, "too_big", "This file is too big to save from the Mac for now (the limit is 150 MB). Add it in the CRM.") }
  // everything is checked AGAIN now: the folder or the name may have changed since the slot was made
  const target = await checkTarget({ ownerId: slot.owner_id, folderId: slot.folder_id }, p.user)
  if (!target.ok) { await back({}); await logAppEvent("app_save_refused", p.user.id, { deviceId: p.deviceId, reason: target.code }, ids); return fromRefusal(target) }
  const free = await checkNameFree(slot.folder_id, slot.file_name as string, (slot.mime_type as string | null) ?? null)
  if (!free.ok) { await back({}); await logAppEvent("app_save_refused", p.user.id, { deviceId: p.deviceId, reason: free.code, name: slot.file_name }, ids); return fromRefusal(free) }
  let result
  try {
    // HIDDEN from clients (published:false) and no document type — Business and My files have no client and need none
    result = await registerStagedUpload({ intentId: p.intentId, actor: p.user.id, published: false })
  } catch (e) {
    await back({})
    throw e
  }
  if (result.status === "queued") throw new Error("A file this big should have been refused earlier.")   // cannot happen: size is capped above the inline limit
  if (result.status !== "created" && result.status !== "unchanged") { await back({}); return refuse(409, result.status, "This file could not be saved here.") }
  await logAppEvent("app_file_saved", p.user.id, { deviceId: p.deviceId, userId: p.user.id, name: result.name, size }, { ownerId: slot.owner_id, folderId: slot.folder_id, fileId: result.fileId })
  return { status: 200, body: { fileId: result.fileId, ownerId: slot.owner_id, name: result.name, size } }
}
