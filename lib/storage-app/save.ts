/**
 * Saving a NEW file from a Mac (dev job 1992a087, phase P3 step A). Two steps, both token-only (`withDevice`):
 *   1. `createSaveSlot` — checks the destination and the name, counts the upload against the Mac's hourly limit, and hands back a
 *      single-use signed upload address (the bytes go straight to storage, not through a CRM function);
 *   2. `saveFromSlot` — checks everything AGAIN, registers the staged file through the CRM's one writer (`registerStagedUpload`), HIDDEN
 *      from clients (`published:false`), and writes the audit row. Saving the same file twice (a retry after a lost answer) returns the
 *      same file — never a second copy. A file whose name is already taken in the folder is REFUSED (the Mac never makes a new version or
 *      overwrites); the rare race that slips past is stored with the writer's " (2)" and the real name is returned.
 * Step A saves only into Business and My files. Never visible to a client: those areas have no client.
 *
 * UPDATE OF ONE'S OWN FILE (phase P3 step C1, Antonio 2026-10-18): a file THIS Mac saved can be updated from this Mac as a NEW VERSION of the same
 * file (macOS sends a half-written snapshot first when an app writes a growing file in place, then the finished content; and an app may re-save
 * its own document). Same two routes, no new path: upload-slot / save take `replaceFileId`. The server checks the file's key belongs to THIS Mac
 * (`storage-app:<deviceId>:` prefix — never another Mac, never a staff upload), that it is live, not filed, and still in an allowed place; the
 * safe save (`appendVersionBytes`, source "mac") adds version N+1; the old versions stay. Same bytes = no new version. The Mac MAY send `baseVersionNo` (the version it started from): then a file changed since answers 409 "conflict" and nothing is overwritten; without it, last write wins (history kept). A locked / filed file answers 422 with plain words (never a retried 500).
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import type { User } from "@supabase/supabase-js"
import { logAppEvent } from "./device-auth"
import { checkDestination, checkNewFile, saveCallerKey, isItemKey, isClientOwnerKind, MAX_UPDATE_BYTES, type SaveRefusal } from "./save-rules"
import { getSettings, clientSaveAllowed, type StorageAppSettings } from "./settings"
import { ensureClientFileRecords, refreshClientRow } from "./client-records"
import { releaseSlotClaim } from "./slot-lease"
import { answerForAppend, parseBaseVersionNo, slotBelongsToUpdate, updateCallerKey } from "./update-rules"
import { lockText } from "@/lib/crm-store/new-version-rules"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* not in generated types until production
const db = () => supabaseAdmin as any

export type SaveStatus = 200 | 202 | 400 | 404 | 409 | 413 | 422 | 429
export interface SaveAnswer { status: SaveStatus; body: Record<string, unknown> }
const refuse = (status: SaveStatus, code: string, message: string): SaveAnswer => ({ status, body: { error: code, message } })
const STATUS_OF: Record<string, SaveStatus> = { not_found: 404, not_allowed: 422, too_big: 413, bad_name: 400, ignored: 422, exists: 409 }
const fromRefusal = (r: Extract<SaveRefusal, { ok: false }>): SaveAnswer => refuse(STATUS_OF[r.code] ?? 422, r.code, r.message)

interface Target { ownerId: string; folderId: string }

/** The destination, from the database: live storage, live folder of THAT storage, allowed area, this login may open it. */
async function checkTarget(t: Target, user: User, settings: StorageAppSettings): Promise<SaveRefusal & { ownerKind?: string }> {
  const { data: folder, error } = await db().from("store_folders").select("id, owner_id, kind, trashed_at").eq("id", t.folderId).maybeSingle()
  if (error) throw new Error(`Could not read the folder (${error.message}).`)
  if (!folder || folder.owner_id !== t.ownerId) return { ok: false, code: "not_found", message: "Folder not found." }
  const { data: owner, error: oErr } = await db().from("store_owners").select("kind, study_only, account_id, contact_id, service_delivery_id").eq("id", t.ownerId).maybeSingle()
  if (oErr) throw new Error(`Could not read the storage (${oErr.message}).`)
  if (!owner || owner.study_only !== false) return { ok: false, code: "not_found", message: "Folder not found." }
  const { isInStaffShare } = await import("@/lib/crm-store/staff-share")
  const rule = checkDestination({ ownerKind: owner.kind, folderKind: folder.kind, inStaffShare: await isInStaffShare(t.folderId), folderTrashed: !!folder.trashed_at,
    clientSaves: settings.clientSaves, ownerIds: { ownerId: t.ownerId, accountId: owner.account_id ?? null, contactId: owner.contact_id ?? null } })
  if (!rule.ok) return rule
  const { denyUnlessAreaAccess, denyUnlessStorePilotEnv } = await import("@/app/api/crm-store/browse/_auth")
  const noAccess = (await denyUnlessAreaAccess({ ownerId: t.ownerId, folderId: t.folderId }, { user })) ?? (await denyUnlessStorePilotEnv({ ownerId: t.ownerId, folderId: t.folderId, user }))
  if (noAccess) return { ok: false, code: "not_found", message: "Folder not found." }
  // a client storage must be linked to a company or a client (checked HERE, before any file is written — the CRM row needs it)
  if (isClientOwnerKind(owner.kind)) {
    const { rowLinksForOwner } = await import("@/lib/crm-store/owner-links")
    const links = await rowLinksForOwner({ kind: owner.kind, account_id: owner.account_id ?? null, contact_id: owner.contact_id ?? null, service_delivery_id: owner.service_delivery_id ?? null })
    if (!links.account && !links.contact) return { ok: false, code: "not_allowed", message: "This storage is not linked to a company or a client — files cannot be added here." }
  }
  return { ok: true, ownerKind: owner.kind }
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

/** A new version is added from memory, so it keeps the writer's inline cap whatever `maxSaveMB` allows for a NEW file. */
const updateCap = (settings: StorageAppSettings): number => Math.min(settings.maxSaveMB * 1024 * 1024, MAX_UPDATE_BYTES)

/** Where a big file's background registration stands: "active" (queued or running), "failed" (every attempt ended without a file), or null (never queued). */
export async function registerJobState(intentId: string): Promise<"active" | "failed" | null> {
  const { REGISTER_UPLOAD_JOB } = await import("@/lib/crm-store/writer")
  const { data, error } = await db().from("job_queue").select("status").eq("job_type", REGISTER_UPLOAD_JOB).eq("related_entity_id", intentId).limit(10)
  if (error) throw new Error(`Could not check the background save (${error.message}).`)
  const states = ((data ?? []) as Array<{ status: string }>).map((j) => j.status)
  if (states.length === 0) return null
  return states.some((x) => x === "pending" || x === "processing") ? "active" : "failed"
}

async function existingByKey(callerKey: string): Promise<{ id: string; owner_id: string; name: string } | null> {
  const { data, error } = await db().from("store_files").select("id, owner_id, name").eq("caller_key", callerKey).eq("state", "live").maybeSingle()
  if (error) throw new Error(`Could not check earlier saves (${error.message}).`)
  return data ?? null
}


export interface OwnFile { id: string; owner_id: string; folder_id: string; name: string; caller_key: string; state: string; filing_status: string | null; document_type?: string | null; needs_review_at?: string | null }

/** The file to update, ONLY if this Mac saved it: its key carries this Mac's id. Anything else is refused with the same plain words. */
async function loadOwnFile(fileId: string, deviceId: string, settings: StorageAppSettings): Promise<OwnFile | { refusal: SaveAnswer }> {
  const none = (message = "Only a file this Mac saved can be changed from this Mac. Open the CRM to change it.") => ({ refusal: refuse(422, "not_own", message) })
  const { data, error } = await db().from("store_files").select("id, owner_id, folder_id, name, caller_key, state, filing_status, document_type, needs_review_at").eq("id", fileId).maybeSingle()
  if (error) throw new Error(`Could not read the file (${error.message}).`)
  if (!data || data.state === "purged") return { refusal: refuse(404, "not_found", "That file was not found.") }
  if (typeof data.caller_key !== "string" || !data.caller_key.startsWith(`storage-app:${deviceId}:`)) return none()
  if (data.state !== "live") return { refusal: refuse(409, "trashed", "That file is in the trash. Restore it in the CRM first.") }
  if (data.filing_status === "filed") return none("This file is filed and frozen. Open the CRM to change it.")
  // a file in a CLIENT storage can be changed from the Mac only while it is still the untouched "Saved from a Mac" file: no type chosen, still marked
  // "Needs review", and not shown by a workspace. Once staff typed it or cleared the mark it is theirs (a hidden-but-typed file is NOT enough).
  const { data: ow } = await db().from("store_owners").select("kind, account_id, contact_id").eq("id", data.owner_id).maybeSingle()
  if (isClientOwnerKind(ow?.kind)) {
    // switched off (or this company not named) in the settings → no Mac change either, not only no new saves
    if (!clientSaveAllowed(settings.clientSaves, { kind: ow.kind, ownerId: data.owner_id, accountId: ow.account_id, contactId: ow.contact_id })) return none("Saving into this client's folders from the Mac is not switched on.")
    const shown = await (await import("@/lib/crm-store/client-visibility")).workspaceShownFiles([data.id])
    if (data.document_type || !data.needs_review_at || shown.size > 0) return none("This file has been typed or reviewed in the CRM, so it can't be changed from the Mac. Open the CRM to change it.")
  }
  return data as OwnFile
}

export async function createSaveSlot(p: { user: User; deviceId: string; ownerId: unknown; folderId: unknown; name: unknown; size: unknown; mimeType: unknown; itemKey: unknown; replaceFileId?: unknown }): Promise<SaveAnswer> {
  const settings = await getSettings()
  if (p.replaceFileId !== undefined && p.replaceFileId !== null) return createUpdateSlot({ settings, user: p.user, deviceId: p.deviceId, fileId: p.replaceFileId, size: p.size, mimeType: p.mimeType, itemKey: p.itemKey })
  if (typeof p.ownerId !== "string" || typeof p.folderId !== "string" || !isItemKey(p.itemKey)) return refuse(400, "bad_request", "Choose a folder and a file.")
  const ids = { ownerId: p.ownerId, folderId: p.folderId }
  const refused = async (code: string, message: string, status: SaveStatus): Promise<SaveAnswer> => {
    await logAppEvent("app_save_refused", p.user.id, { deviceId: p.deviceId, reason: code, name: typeof p.name === "string" ? p.name.slice(0, 120) : null }, ids)
    return refuse(status, code, message)
  }
  const callerKey = saveCallerKey(p.deviceId, p.itemKey)
  const earlier = await existingByKey(callerKey)
  if (earlier) { await ensureClientFileRecords(earlier.id, p.user.id); return { status: 200, body: { alreadySaved: true, fileId: earlier.id, ownerId: earlier.owner_id, name: earlier.name } } }
  const file = checkNewFile({ name: p.name, size: p.size }, settings.maxSaveMB * 1024 * 1024)
  if (file.ok === false) return refused(file.code, file.message, STATUS_OF[file.code] ?? 422)
  const mimeType = typeof p.mimeType === "string" && p.mimeType ? p.mimeType.slice(0, 200) : null
  const target = await checkTarget({ ownerId: p.ownerId, folderId: p.folderId }, p.user, settings)
  if (target.ok === false) return refused(target.code, target.message, STATUS_OF[target.code] ?? 422)
  const free = await checkNameFree(p.folderId, file.cleanName!, mimeType)
  if (free.ok === false) return refused(free.code, free.message, STATUS_OF[free.code] ?? 409)
  // the hourly upload limit: counted and audited in ONE database step; a database error = no slot (fail closed)
  const { data: reserve, error: rErr } = await db().rpc("storage_app_reserve_write", {
    p_device: p.deviceId, p_user: p.user.id, p_owner: p.ownerId, p_name: file.cleanName, p_caller_key: callerKey, p_size: p.size as number, p_limit: settings.writeLimitMB * 1024 * 1024,
  })
  if (rErr) throw new Error(`Could not check the upload limit (${rErr.message}).`)
  if (!(reserve as { allowed?: boolean } | null)?.allowed) return refuse(429, "upload_limit", "This Mac has uploaded a lot in the last hour. Try again later, or add the files in the CRM.")
  const { createServerUploadIntent, STORE_STAGING_BUCKET } = await import("@/lib/crm-store/writer")
  // a retry for the same file reuses its open slot (a fresh address for it), never a second slot
  const { data: open } = await db().from("store_upload_intents").select("id, staging_path").eq("caller_key", callerKey).eq("created_by", p.user.id).is("consumed_at", null).gt("expires_at", new Date().toISOString()).limit(1).maybeSingle()
  let intentId = open?.id as string | undefined
  let stagingPath = open?.staging_path as string | undefined
  const maxBytes = settings.maxSaveMB * 1024 * 1024
  if (open) {
    const job = await registerJobState(open.id)
    if (job === "active") return { status: 200, body: { intentId: open.id, alreadyUploaded: true, maxBytes } }       // the bytes are in; the CRM is still registering them
    if (job === "failed") {
      // the background save gave up: that slot is finished, the Mac starts this file over with a new one
      const { discardUploadIntentObjects } = await import("@/lib/crm-store/writer")
      await discardUploadIntentObjects(open.id)
      await db().from("store_upload_intents").update({ consumed_at: new Date().toISOString() }).eq("id", open.id).is("consumed_at", null)
      intentId = undefined; stagingPath = undefined
    } else {
      // the bytes may already be there (the answer to the upload was lost): the same size means the Mac need not send them again
      const { storedSize } = await import("@/lib/crm-store/writer")
      const staged = await storedSize(STORE_STAGING_BUCKET, open.staging_path).catch(() => null)
      if (staged === (p.size as number)) return { status: 200, body: { intentId: open.id, alreadyUploaded: true, maxBytes } }
      if (staged !== null) await supabaseAdmin.storage.from(STORE_STAGING_BUCKET).remove([open.staging_path])    // another size: the file changed, send it again
    }
  }
  if (!intentId) {
    const i = await createServerUploadIntent({ ownerId: p.ownerId, folderId: p.folderId, fileName: file.cleanName!, mimeType, callerKey, actor: p.user.id })
    intentId = i.intentId; stagingPath = i.stagingPath
  }
  const { data: signed, error: sErr } = await supabaseAdmin.storage.from(STORE_STAGING_BUCKET).createSignedUploadUrl(stagingPath!)
  if (sErr || !signed?.signedUrl) throw new Error(`Could not prepare the upload (${sErr?.message ?? "no address"}).`)
  return { status: 200, body: { intentId, uploadUrl: signed.signedUrl, maxBytes } }
}

async function createUpdateSlot(p: { settings: StorageAppSettings; user: User; deviceId: string; fileId: unknown; size: unknown; mimeType: unknown; itemKey: unknown }): Promise<SaveAnswer> {
  if (typeof p.fileId !== "string" || !isItemKey(p.itemKey)) return refuse(400, "bad_request", "Choose a file.")
  const own = await loadOwnFile(p.fileId, p.deviceId, p.settings)
  if ("refusal" in own) return own.refusal
  const ids = { ownerId: own.owner_id, folderId: own.folder_id, fileId: own.id }
  const refused = async (code: string, message: string, status: SaveStatus): Promise<SaveAnswer> => {
    await logAppEvent("app_save_refused", p.user.id, { deviceId: p.deviceId, reason: code, update: true, name: own.name.slice(0, 120) }, ids)
    return refuse(status, code, message)
  }
  const file = checkNewFile({ name: own.name, size: p.size }, updateCap(p.settings))     // size cap and a usable size (the name is the file's own)
  if (file.ok === false) return refused(file.code, file.message, STATUS_OF[file.code] ?? 422)
  const target = await checkTarget({ ownerId: own.owner_id, folderId: own.folder_id }, p.user, p.settings)
  if (target.ok === false) return refused(target.code, target.message, STATUS_OF[target.code] ?? 422)
  const mimeType = typeof p.mimeType === "string" && p.mimeType ? p.mimeType.slice(0, 200) : null
  // a file that takes no new version (signed, passport/ID, replaced, amended, filed) is refused BEFORE anything is uploaded
  const { data: lockKind, error: lErr } = await db().rpc("store_lock_class", { p_file_id: own.id })
  if (!lErr && typeof lockKind === "string" && lockKind) return refused("locked", lockText(lockKind, own.name), 422)
  // this update is counted against the hourly upload limit under its own key (a retry of the same update is not counted twice)
  const updateKey = updateCallerKey(own.caller_key, p.itemKey as string)
  const { data: reserve, error: rErr } = await db().rpc("storage_app_reserve_write", {
    p_device: p.deviceId, p_user: p.user.id, p_owner: own.owner_id, p_name: own.name, p_caller_key: updateKey, p_size: p.size as number, p_limit: p.settings.writeLimitMB * 1024 * 1024,
  })
  if (rErr) throw new Error(`Could not check the upload limit (${rErr.message}).`)
  if (!(reserve as { allowed?: boolean } | null)?.allowed) return refuse(429, "upload_limit", "This Mac has uploaded a lot in the last hour. Try again later, or add the files in the CRM.")
  const { createServerUploadIntent, STORE_STAGING_BUCKET } = await import("@/lib/crm-store/writer")
  // ONE slot per update: the slot carries the file's key PLUS this update's item key, so a second update (another item key) never gets the
  // first update's slot. Only an open slot of THIS update is reused (a retry). The save adds a version to the file through the safe save
  // (appendVersionBytes), so the slot's key is only a tag.
  const { data: open } = await db().from("store_upload_intents").select("id, staging_path").eq("caller_key", updateKey).eq("created_by", p.user.id).is("consumed_at", null).gt("expires_at", new Date().toISOString()).limit(1).maybeSingle()
  let intentId = open?.id as string | undefined
  let stagingPath = open?.staging_path as string | undefined
  if (!intentId) {
    const i = await createServerUploadIntent({ ownerId: own.owner_id, folderId: own.folder_id, fileName: own.name, mimeType, callerKey: updateKey, actor: p.user.id })
    intentId = i.intentId; stagingPath = i.stagingPath
  }
  const { data: signed, error: sErr } = await supabaseAdmin.storage.from(STORE_STAGING_BUCKET).createSignedUploadUrl(stagingPath!)
  if (sErr || !signed?.signedUrl) throw new Error(`Could not prepare the upload (${sErr?.message ?? "no address"}).`)
  return { status: 200, body: { intentId, uploadUrl: signed.signedUrl, maxBytes: updateCap(p.settings), update: true, fileId: own.id } }
}

async function giveBackReservation(p: { user: User; deviceId: string; callerKey: string; size: number }) {
  await logAppEvent("app_upload_refunded", p.user.id, { deviceId: p.deviceId, callerKey: p.callerKey, size: Math.max(p.size, 1048576) })
}

async function saveUpdate(p: { settings: StorageAppSettings; user: User; deviceId: string; intentId: unknown; itemKey: unknown; fileId: unknown; baseVersionNo?: unknown }): Promise<SaveAnswer> {
  if (typeof p.intentId !== "string" || typeof p.fileId !== "string" || !isItemKey(p.itemKey)) return refuse(400, "bad_request", "The upload is not complete.")
  const own = await loadOwnFile(p.fileId, p.deviceId, p.settings)
  if ("refusal" in own) return own.refusal
  const ids = { ownerId: own.owner_id, folderId: own.folder_id, fileId: own.id }
  const updateKey = updateCallerKey(own.caller_key, p.itemKey)
  const { data: slot, error } = await db().from("store_upload_intents").select("id, owner_id, folder_id, caller_key, created_by, consumed_at, file_id, expires_at, staging_path, mime_type").eq("id", p.intentId).maybeSingle()
  if (error) throw new Error(`Could not read the upload slot (${error.message}).`)
  const belongs = slot ? slotBelongsToUpdate({ slotKey: slot.caller_key, fileCallerKey: own.caller_key, itemKey: p.itemKey }) : "no"
  if (!slot || slot.created_by !== p.user.id || belongs === "no" || slot.owner_id !== own.owner_id) return refuse(404, "not_found", "This upload was not found. Try saving again.")
  // a retry after a lost answer: THIS update's slot was already used for THIS file → the update is done. A slot of another update (or an
  // older-style slot that cannot be tied to this update) is never answered as a repeat, because its content may not be this update's.
  if (slot.consumed_at) {
    if (belongs === "match" && slot.file_id === own.id) return { status: 200, body: { fileId: own.id, ownerId: own.owner_id, name: own.name, repeated: true } }
    return refuse(409, "slot_closed", "This upload is no longer open. Try saving again.")
  }
  if (new Date(slot.expires_at).getTime() < Date.now()) return refuse(409, "slot_closed", "This upload is no longer open. Try saving again.")
  const { storedSize, appendVersionBytes, STORE_STAGING_BUCKET } = await import("@/lib/crm-store/writer")
  let size: number
  try { size = await storedSize(STORE_STAGING_BUCKET, slot.staging_path as string) } catch { return refuse(409, "not_uploaded", "The file did not arrive. Try saving again.") }
  const back = () => giveBackReservation({ user: p.user, deviceId: p.deviceId, callerKey: updateKey, size })
  if (size > updateCap(p.settings)) { await back(); return refuse(413, "too_big", `A new version of a file can be up to ${Math.floor(updateCap(p.settings) / 1048576)} MB from the Mac. Add it in the CRM.`) }
  const target = await checkTarget({ ownerId: own.owner_id, folderId: own.folder_id }, p.user, p.settings)
  if (target.ok === false) { await back(); await logAppEvent("app_save_refused", p.user.id, { deviceId: p.deviceId, reason: target.code, update: true }, ids); return fromRefusal(target) }

  // claim the slot (a lease: two saves of the same slot at once → the second waits), read the staged bytes, add the version through the ONE safe save
  const { error: cErr } = await db().rpc("store_claim_intent", { p_intent_id: p.intentId, p_actor: p.user.id })
  if (cErr) {
    if (/busy|already registered|unknown/i.test(cErr.message ?? "")) return refuse(409, "slot_busy", "This upload is already being saved. Wait a moment and try again.")
    throw new Error(`Could not claim the upload slot (${cErr.message}).`)
  }
  const { data: blob, error: dErr } = await db().storage.from(STORE_STAGING_BUCKET).download(slot.staging_path as string)
  // the lease taken above is given back on every exit that leaves the slot open, so the Mac's retry is not told "busy" for 15 minutes
  const releaseClaim = () => releaseSlotClaim(db(), p.intentId as string)
  if (dErr || !blob) { await releaseClaim(); await back(); return refuse(409, "not_uploaded", "The file did not arrive. Try saving again.") }
  let bytes: Buffer
  try { bytes = Buffer.from(await blob.arrayBuffer()) } catch (e) { await releaseClaim(); await back(); throw e }
  const mimeType = (slot.mime_type as string | null) || blob.type || null
  // the version the Mac started from (OPTIONAL — a Mac that does not send it keeps today's "last write wins, history kept")
  const baseVersionNo = parseBaseVersionNo(p.baseVersionNo)
  let res
  try {
    res = await appendVersionBytes({ fileId: own.id, bytes, mimeType, expectedVersionNo: baseVersionNo, actor: p.user.id, source: "mac", deviceId: p.deviceId })
  } catch (e) { await releaseClaim(); await back(); throw e }
  const answer = answerForAppend(res, own.id, own.owner_id, own.name, size)
  const closeSlot = async (fileId: string | null) => {
    await db().from("store_upload_intents").update({ consumed_at: new Date().toISOString(), ...(fileId ? { file_id: fileId } : {}) }).eq("id", p.intentId).is("consumed_at", null)
    await db().storage.from(STORE_STAGING_BUCKET).remove([slot.staging_path as string]).catch(() => {})
  }
  if (!answer.done) {
    // nothing was changed: the slot is closed (a retry of it is "no longer open"), the upload is given back, the Mac gets plain words
    await closeSlot(null)
    await back()
    await logAppEvent("app_save_refused", p.user.id, { deviceId: p.deviceId, reason: String(answer.body.error), update: true, name: own.name.slice(0, 120) }, ids)
    return { status: answer.status, body: answer.body }
  }
  await closeSlot(own.id)
  await refreshClientRow(own.id)      // a client storage: the documents row follows the new size / type (no-op elsewhere)
  await logAppEvent("app_file_updated", p.user.id, { deviceId: p.deviceId, userId: p.user.id, name: own.name, size, outcome: res.status, versionNo: res.versionNo ?? null, baseVersionNo }, ids)
  return { status: 200, body: answer.body }
}

export async function saveFromSlot(p: { user: User; deviceId: string; intentId: unknown; itemKey: unknown; replaceFileId?: unknown; baseVersionNo?: unknown }): Promise<SaveAnswer> {
  const settings = await getSettings()
  if (p.replaceFileId !== undefined && p.replaceFileId !== null) return saveUpdate({ settings, user: p.user, deviceId: p.deviceId, intentId: p.intentId, itemKey: p.itemKey, fileId: p.replaceFileId, baseVersionNo: p.baseVersionNo })
  if (typeof p.intentId !== "string" || !isItemKey(p.itemKey)) return refuse(400, "bad_request", "The upload is not complete.")
  const callerKey = saveCallerKey(p.deviceId, p.itemKey)
  const earlier = await existingByKey(callerKey)
  if (earlier) { await ensureClientFileRecords(earlier.id, p.user.id); return { status: 200, body: { fileId: earlier.id, ownerId: earlier.owner_id, name: earlier.name, repeated: true } } }
  const { data: slot, error } = await db().from("store_upload_intents").select("id, owner_id, folder_id, file_name, mime_type, caller_key, created_by, consumed_at, expires_at, staging_path, dest_path").eq("id", p.intentId).maybeSingle()
  if (error) throw new Error(`Could not read the upload slot (${error.message}).`)
  if (!slot || slot.created_by !== p.user.id || slot.caller_key !== callerKey) return refuse(404, "not_found", "This upload was not found. Try saving again.")
  if (slot.consumed_at || new Date(slot.expires_at).getTime() < Date.now()) return refuse(409, "slot_closed", "This upload is no longer open. Try saving again.")
  const ids = { ownerId: slot.owner_id as string, folderId: slot.folder_id as string }
  const { storedSize, registerStagedUpload, discardUploadIntentObjects, STORE_STAGING_BUCKET, STORE_BUCKET } = await import("@/lib/crm-store/writer")
  // a BIG file (over the writer's inline cap) is registered by a background job: while it runs the Mac is told "pending" and asks again; if it gave up, the Mac is told so
  const job = await registerJobState(p.intentId)
  if (job === "active") return { status: 202, body: { pending: true } }
  if (job === "failed") {
    const gone = (await storedSize(STORE_STAGING_BUCKET, slot.staging_path as string).catch(() => null)) ?? (slot.dest_path ? await storedSize(STORE_BUCKET, slot.dest_path as string).catch(() => null) : null)
    await giveBackReservation({ user: p.user, deviceId: p.deviceId, callerKey, size: gone ?? 0 })
    await discardUploadIntentObjects(p.intentId)
    await db().from("store_upload_intents").update({ consumed_at: new Date().toISOString() }).eq("id", p.intentId).is("consumed_at", null)
    await logAppEvent("app_save_refused", p.user.id, { deviceId: p.deviceId, reason: "register_failed", name: slot.file_name }, ids)
    return refuse(409, "register_failed", "This big file could not be saved. Try again, or add it in the CRM.")
  }
  let size: number
  try { size = await storedSize(STORE_STAGING_BUCKET, slot.staging_path as string) } catch { return refuse(409, "not_uploaded", "The file did not arrive. Try saving again.") }
  const back = (extra: Record<string, unknown>) => giveBackReservation({ user: p.user, deviceId: p.deviceId, callerKey, size }).then(() => extra)
  if (size > settings.maxSaveMB * 1024 * 1024) { await back({}); return refuse(413, "too_big", `This file is too big to save from the Mac for now (the limit is ${settings.maxSaveMB} MB). Add it in the CRM.`) }
  // everything is checked AGAIN now: the folder or the name may have changed since the slot was made
  const target = await checkTarget({ ownerId: slot.owner_id, folderId: slot.folder_id }, p.user, settings)
  if (target.ok === false) { await back({}); await logAppEvent("app_save_refused", p.user.id, { deviceId: p.deviceId, reason: target.code }, ids); return fromRefusal(target) }
  const free = await checkNameFree(slot.folder_id, slot.file_name as string, (slot.mime_type as string | null) ?? null)
  if (free.ok === false) { await back({}); await logAppEvent("app_save_refused", p.user.id, { deviceId: p.deviceId, reason: free.code, name: slot.file_name }, ids); return fromRefusal(free) }
  let result
  try {
    // HIDDEN from clients (published:false) and no document type — Business and My files have no client and need none; a client storage gets
    // "Needs review" + its documents row right after (ensureClientFileRecords), and the year of a Tax › year folder
    const clientSave = isClientOwnerKind(target.ownerKind)
    const periodYear = clientSave ? await (await import("@/lib/crm-store/structure")).nearestYear(slot.folder_id) : null
    result = await registerStagedUpload({ intentId: p.intentId, actor: p.user.id, published: false, ...(periodYear ? { periodYear } : {}) })
  } catch (e) {
    await back({})
    throw e
  }
  if (result.status === "queued") {
    // over the inline cap: the CRM registers it in the background (hash, move, record); the Mac asks again until the file exists
    await logAppEvent("app_save_queued", p.user.id, { deviceId: p.deviceId, userId: p.user.id, name: slot.file_name, size, jobId: result.jobId }, ids)
    return { status: 202, body: { pending: true, jobId: result.jobId } }
  }
  if (result.status !== "created" && result.status !== "unchanged") { await back({}); return refuse(409, result.status, "This file could not be saved here.") }
  await logAppEvent("app_file_saved", p.user.id, { deviceId: p.deviceId, userId: p.user.id, name: result.name, size, needsType: isClientOwnerKind(target.ownerKind) }, { ownerId: slot.owner_id, folderId: slot.folder_id, fileId: result.fileId })
  // a failure here leaves a HIDDEN file without its mark/row: the Mac is told it failed, its retry (or the nightly sweep) applies them
  await ensureClientFileRecords(result.fileId, p.user.id)
  return { status: 200, body: { fileId: result.fileId, ownerId: slot.owner_id, name: result.name, size } }
}
