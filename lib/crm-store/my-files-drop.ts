/**
 * My files DROP — the one server function behind the MCP tool `my_files_save` (dev job 1ed4fb18, Antonio 2026-10-17).
 *
 * A Claude session may SAVE one file into the owner's private "My files" › "From Claude" folder — and do nothing else there:
 * no read, no list, no overwrite, no delete, no move. This is deliberately NOT a route and NOT a browse helper: it loosens
 * nothing in the private-area guards (`denyUnlessAreaAccess`, `mayOpenPrivateArea` are untouched). Nothing here accepts an
 * owner id or a folder id from the caller; the owner is resolved from PRIMARY_OWNER_EMAIL, the drop folder is a folder that
 * THIS module made and re-verifies on every call.
 *
 * Write-once: every save is written with contentChanged=false, so `store_write` returns "unchanged" for a key that already
 * exists and can never add a version; the stored sha is compared afterwards and a difference is refused. A name clash with
 * another file gets the writer's " (2)" — nothing is ever replaced.
 */
import { supabaseAdmin } from "@/lib/supabase-admin"
import { saveBytesToStore, StoreFrozenFileError } from "./writer"
import { effectiveKind, ownersAreaUserId } from "./structure"
import {
  DROP_DRIVE_ACTION, DROP_FOLDER_NAME, DROP_FOLDER_SETTING, DROP_KEY_PREFIX, DROP_LIMITS,
  checkDropContent, checkDropName, checkDropSubfolder, decodeDropContent, dropCallerKey, dropDrivePullRefusal, dropRateRefusal,
  driveCallerKey, driveCopyName, sha256Of,
  type RecentDrops,
} from "./my-files-drop-rules"
import { driveRootFolder, fetchDriveBytes, inspectDriveFile, realDriveReader, type DriveReader } from "./my-files-drop-drive"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* tables are not in the generated types
const db = () => supabaseAdmin as any

export interface DropCaller { method: string; email: string }
export interface DropInput { name?: unknown; subfolder?: unknown; text?: unknown; content_base64?: unknown; drive_file_id?: unknown; caller_key?: unknown }
/** Where the bytes came from, for the audit row and the stored file's provenance note (a Drive copy only). */
interface DriveSource { fileId: string; md5: string; version: string | null; modifiedTime: string | null }
export type DropResult =
  | { ok: true; status: "created" | "unchanged"; path: string; name: string; size: number; sha256_prefix: string; note: string }
  | { ok: false; error: string }

export const dropEnabled = (): boolean => process.env.MY_FILES_DROP_ENABLED === "1"

const fail = (error: string): DropResult => ({ ok: false, error })
const ALREADY_SAVED = "(already saved earlier — its current place is not shown)"
const INTERNAL = "The file could not be saved right now. Nothing was changed; try again in a minute."

/** The owner's private My files area (must already exist — this tool never creates an area). */
async function resolveArea(): Promise<{ ownerId: string; userId: string; rootId: string } | string> {
  const userId = await ownersAreaUserId()
  if (!userId) return "The owner's login was not found, so there is no My files to save into."
  const { data: o, error } = await db().from("store_owners").select("id").eq("kind", "private").eq("private_user_id", userId).maybeSingle()
  if (error) throw new Error(`owner lookup: ${error.message}`)
  if (!o) return "The owner has no My files yet — open the Storage page once, then try again."
  const { data: root, error: rErr } = await db().from("store_folders").select("id")
    .eq("owner_id", o.id).eq("kind", "private_root").is("parent_id", null).is("trashed_at", null).maybeSingle()
  if (rErr) throw new Error(`root lookup: ${rErr.message}`)
  if (!root) return "The My files top folder was not found."
  return { ownerId: o.id as string, userId, rootId: root.id as string }
}

/** Is this folder a live, plain folder of this owner whose nearest fixed ancestor is the My files top (NOT "Shared with staff")? */
async function dropFolderOk(folderId: string, ownerId: string): Promise<boolean> {
  const { data: f, error } = await db().from("store_folders").select("id, owner_id, kind, trashed_at").eq("id", folderId).maybeSingle()
  if (error) throw new Error(`drop folder lookup: ${error.message}`)
  if (!f || f.owner_id !== ownerId || f.trashed_at || f.kind !== "custom") return false
  try { return (await effectiveKind(folderId)) === "private_root" } catch { return false }
}

/** The drop folder id: the remembered one if it still checks out, else (re)made under the top folder and remembered. */
async function dropFolder(area: { ownerId: string; rootId: string }): Promise<string> {
  const { data: row, error } = await db().from("app_settings").select("value").eq("key", DROP_FOLDER_SETTING).maybeSingle()
  if (error) throw new Error(`setting read: ${error.message}`) // a read error must NOT look like "no folder yet"
  const remembered = typeof row?.value === "string" ? (row.value as string) : null
  if (remembered && (await dropFolderOk(remembered, area.ownerId))) return remembered
  const { data: id, error: fErr } = await db().rpc("store_ensure_folder_path", { p_owner: area.ownerId, p_parent: area.rootId, p_path: [DROP_FOLDER_NAME], p_actor: null })
  if (fErr || !id) throw new Error(`drop folder: ${fErr?.message ?? "no id"}`)
  if (!(await dropFolderOk(id as string, area.ownerId))) throw new Error("drop folder: the folder named like it is not a plain folder of My files")
  const { error: wErr } = await db().from("app_settings").upsert({ key: DROP_FOLDER_SETTING, value: id, updated_at: new Date().toISOString() }, { onConflict: "key" })
  if (wErr) throw new Error(`setting write: ${wErr.message}`)
  return id as string
}

/** "My files › From Claude › Plans" from the file's REAL folder (it may have been moved or renamed since). */
async function pathOfFolder(folderId: string): Promise<string> {
  const names: string[] = []
  let cur: string | null = folderId
  for (let i = 0; i < 50 && cur; i++) {
    const { data: f, error } = await db().from("store_folders").select("name, parent_id").eq("id", cur).maybeSingle()
    if (error || !f) break
    names.unshift(f.name as string)
    cur = f.parent_id as string | null
  }
  return names.join(" › ")
}

async function recentDrops(ownerId: string): Promise<RecentDrops> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  const { data, error } = await db().from("store_events").select("occurred_at, details")
    .eq("event", "created").eq("owner_id", ownerId).like("details->>caller_key", `${DROP_KEY_PREFIX}%`).gte("occurred_at", since).limit(1000)
  if (error) throw new Error(`rate lookup: ${error.message}`)
  const hourAgo = Date.now() - 3600_000
  let lastHour = 0
  let bytes = 0
  for (const e of (data ?? []) as Array<{ occurred_at: string; details: { size?: number | string } | null }>) {
    if (new Date(e.occurred_at).getTime() >= hourAgo) lastHour++
    bytes += Number(e.details?.size ?? 0) || 0
  }
  return { lastHour, lastDay: (data ?? []).length, bytesLastDay: bytes }
}

/** Drive pulls started in the last hour — every attempt counts, refused ones too. */
async function pullsLastHour(): Promise<number> {
  const since = new Date(Date.now() - 3600_000).toISOString()
  const { count, error } = await db().from("action_log").select("id", { count: "exact", head: true })
    .eq("action_type", DROP_DRIVE_ACTION).eq("table_name", "google_drive").gte("created_at", since)
  if (error) throw new Error(`pull count: ${error.message}`)
  return Number(count ?? 0)
}

/** The file that already holds this key (any state but purged), with its current content hash. */
async function fileForKey(key: string): Promise<{ id: string; ownerId: string; folderId: string; name: string; state: string; sha: string | null } | null> {
  const { data: f, error } = await db().from("store_files").select("id, owner_id, folder_id, name, state, current_version_id").eq("caller_key", key).neq("state", "purged").maybeSingle()
  if (error) throw new Error(`key lookup: ${error.message}`)
  if (!f) return null
  let sha: string | null = null
  if (f.current_version_id) {
    const { data: v, error: vErr } = await db().from("store_file_versions").select("sha256").eq("id", f.current_version_id).maybeSingle()
    if (vErr) throw new Error(`version lookup: ${vErr.message}`)
    sha = (v?.sha256 as string | undefined) ?? null
  }
  return { id: f.id as string, ownerId: f.owner_id as string, folderId: f.folder_id as string, name: f.name as string, state: f.state as string, sha }
}

async function audit(caller: DropCaller, d: { status: string; path: string; name: string; size: number; sha256: string; key: string; fileId: string; drive?: DriveSource }): Promise<void> {
  const { error } = await db().from("action_log").insert({
    actor: "claude.mcp", action_type: "create", table_name: "store_files", record_id: d.fileId,
    summary: `my_files_save: ${d.status} "${d.name}" in ${d.path}`,
    details: { tool: "my_files_save", status: d.status, path: d.path, size: d.size, sha256: d.sha256, caller_key: d.key, auth_method: caller.method, caller_email: caller.email, untrusted_ai_content: true,
      ...(d.drive ? { source: "google_drive", drive_file_id: d.drive.fileId, drive_md5: d.drive.md5, drive_version: d.drive.version } : {}) },
  })
  if (error) console.error("[my-files-drop] AUDIT WRITE FAILED:", error.message) // the store_events row still exists
}

export async function saveToMyFilesDrop(input: DropInput, caller: DropCaller, driveReader?: DriveReader): Promise<DropResult> {
  try {
    if (!dropEnabled()) return fail("This tool is switched off. It is turned on with the setting MY_FILES_DROP_ENABLED=1.")

    const fromDrive = input.drive_file_id !== undefined && input.drive_file_id !== null
    const hasInline = (input.text !== undefined && input.text !== null) || (input.content_base64 !== undefined && input.content_base64 !== null)
    if (fromDrive && hasInline) return fail("Send exactly one of: text, content_base64, or drive_file_id.")

    const sub = checkDropSubfolder(input.subfolder)
    if (sub.ok === false) return fail(sub.error)

    let nm: { name: string; ext: string; mime: string }
    let bytes: Buffer
    let k: { key: string; derived: boolean }
    let drive: DriveSource | undefined

    if (fromDrive) {
      const root = driveRootFolder()
      if (!root) return fail("Copying from Google Drive is not switched on (no Drive folder is set).")
      if (typeof input.drive_file_id !== "string" || !/^[A-Za-z0-9_-]{10,100}$/.test(input.drive_file_id)) return fail("drive_file_id must be a Google Drive file id (letters, digits, - and _ only). Links are not accepted.")
      const reader = driveReader ?? (await realDriveReader())
      // every attempt is counted and logged BEFORE Drive is touched, refused ones too (a looping session must not burn the Drive quota with guesses)
      const tooMany = dropDrivePullRefusal(await pullsLastHour())
      if (tooMany) return fail(tooMany)
      const { error: pullErr } = await db().from("action_log").insert({
        actor: "claude.mcp", action_type: DROP_DRIVE_ACTION, table_name: "google_drive", record_id: input.drive_file_id,
        summary: `my_files_save: read-only look at a file in Antonio's Google Drive`,
        details: { tool: "my_files_save", drive_file_id: input.drive_file_id, auth_method: caller.method, caller_email: caller.email, untrusted_ai_content: true },
      })
      if (pullErr) throw new Error(`pull log: ${pullErr.message}`) // no log, no Drive read
      const seen = await inspectDriveFile(reader, input.drive_file_id, root)
      if (seen.ok === false) return fail(seen.error)
      const meta = seen.meta
      const dn = driveCopyName(input.name, meta.name)
      if (dn.ok === false) return fail(dn.error)
      const chk = checkDropName(dn.name)
      if (chk.ok === false) return fail(input.name ? chk.error : `${chk.error} The Drive file's own name is not usable — pass \`name\` with a clean file name.`)
      nm = chk
      const dk = driveCallerKey(input.caller_key, sub.segments, nm.name, meta.id, meta.md5 as string)
      if (dk.ok === false) return fail(dk.error)
      k = dk
      drive = { fileId: meta.id, md5: meta.md5 as string, version: meta.version, modifiedTime: meta.modifiedTime }

      const area0 = await resolveArea()
      if (typeof area0 === "string") return fail(area0)
      // an unchanged file that was copied before costs no download at all (the default key holds the Drive id + checksum)
      if (k.derived) {
        const prior = await fileForKey(k.key)
        if (prior && prior.ownerId === area0.ownerId) {
          if (prior.state === "trashed") return fail("That file was deleted from Storage earlier. Use a new caller_key to save it again.")
          return { ok: true, status: "unchanged", path: ALREADY_SAVED, name: nm.name, size: meta.size as number, sha256_prefix: (meta.md5 as string).slice(0, 12), note: "The identical file was already copied; no second copy was made." }
        }
      }
      const limited0 = dropRateRefusal(await recentDrops(area0.ownerId), meta.size as number)
      if (limited0) return fail(limited0)
      const got = await fetchDriveBytes(reader, meta, root)
      if (got.ok === false) return fail(got.error)
      bytes = got.bytes
      const content = checkDropContent(nm.ext, bytes)
      if (content.ok === false) return fail(content.error)
    } else {
      const n0 = checkDropName(input.name)
      if (n0.ok === false) return fail(n0.error)
      nm = n0
      const body = decodeDropContent(input.text, input.content_base64)
      if (body.ok === false) return fail(body.error)
      const content = checkDropContent(nm.ext, body.bytes)
      if (content.ok === false) return fail(content.error)
      bytes = body.bytes
      const k0 = dropCallerKey(input.caller_key, sub.segments, nm.name, sha256Of(bytes))
      if (k0.ok === false) return fail(k0.error)
      k = k0
    }
    const sha = sha256Of(bytes)
    const body = { bytes }

    const area = await resolveArea()
    if (typeof area === "string") return fail(area)

    // a key that is already used: the same content is a no-op; different content or a deleted file is refused
    const existing = await fileForKey(k.key)
    if (existing) {
      if (existing.ownerId !== area.ownerId) return fail(INTERNAL)
      if (existing.state === "trashed") return fail("That file was deleted from Storage earlier. Use a new caller_key to save it again.")
      if (existing.sha !== sha) return fail("This caller_key already holds a different file. Use a new caller_key (or leave caller_key out) to save this content.")
      // write-only: say nothing about where the file is NOW (Antonio may have renamed or moved it into other private folders)
      return { ok: true, status: "unchanged", path: ALREADY_SAVED, name: nm.name, size: body.bytes.length, sha256_prefix: sha.slice(0, 12), note: "The identical file was already saved; no second copy was made." }
    }

    const recent = await recentDrops(area.ownerId)
    const limited = dropRateRefusal(recent, body.bytes.length)
    if (limited) return fail(limited)

    const drop = await dropFolder(area)
    let target = drop
    if (sub.segments.length) {
      const { data: id, error } = await db().rpc("store_ensure_folder_path", { p_owner: area.ownerId, p_parent: drop, p_path: sub.segments, p_actor: null })
      if (error || !id) throw new Error(`subfolder: ${error?.message ?? "no id"}`)
      target = id as string
    }

    let res
    try {
      res = await saveBytesToStore({
        ownerId: area.ownerId, folderId: target, name: nm.name, mimeType: nm.mime, callerKey: k.key,
        contentChanged: false, // write-once: an existing key can only ever answer "unchanged", never add a version
        published: false, actor: null, documentType: null, skipAnalysis: true, bytes: body.bytes,
        facts: [
          { key: "saved_by", value: "Claude session via MCP my_files_save — untrusted AI-session content, not reviewed", source: "rule" },
          ...(drive ? [{ key: "copied_from", value: `Antonio's Google Drive (read-only copy) — Drive checksum ${drive.md5}${drive.modifiedTime ? `, modified ${drive.modifiedTime}` : ""}`, source: "rule" as const }] : []),
        ],
      })
    } catch (e) {
      if (e instanceof StoreFrozenFileError) return fail("That file is marked as filed and cannot be changed. Use a new caller_key.")
      throw e
    }
    if (res.status === "trashed") return fail("That file was deleted from Storage earlier. Use a new caller_key to save it again.")

    // a simultaneous save of different content under the same key lands here as "unchanged": make sure what is stored is OUR content
    let stored
    try { stored = await fileForKey(k.key) } catch (e) { console.error("[my-files-drop] re-check failed:", e instanceof Error ? e.message : e); stored = null }
    if (!stored) return fail("The file may have been saved, but this could not be confirmed. Retry with the same caller_key (it is safe: a saved file is not duplicated).")
    if (stored.ownerId !== area.ownerId) return fail(INTERNAL)
    if (stored.sha !== sha) return fail("This caller_key was just used for a different file. Use a new caller_key.")

    const status = res.status === "created" ? "created" : "unchanged"
    const folderPath = await pathOfFolder(stored.folderId)
    const path = status === "created" ? `${folderPath} › ${stored.name}` : ALREADY_SAVED
    await audit(caller, { status, path: folderPath, name: stored.name, size: body.bytes.length, sha256: sha, key: k.key, fileId: stored.id, drive })
    return {
      ok: true, status, path, name: stored.name, size: body.bytes.length, sha256_prefix: sha.slice(0, 12),
      note: status === "created" ? (stored.name !== nm.name ? `A file named "${nm.name}" already existed, so this one was saved as "${stored.name}".` : "Saved.") : "The identical file was already saved; no second copy was made.",
    }
  } catch (e) {
    console.error("[my-files-drop] failed:", e instanceof Error ? e.message : e) // the real reason stays in the server log, never in the answer
    return fail(INTERNAL)
  }
}

export { DROP_LIMITS }
