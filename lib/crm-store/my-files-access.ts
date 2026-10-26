/**
 * My files ACCESS — the server half behind the MCP tools `my_files_list/read/write/new_folder/rename/move/trash/trash_list/restore`
 * (Antonio, 2026-10-23: full read/write access for his own Claude sessions, option 4). The pure rules are in `my-files-access-rules.ts`.
 *
 * Boundaries that never move, whatever the caller sends:
 *   - OFF unless MY_FILES_ACCESS_ENABLED=1; the MCP tool layer already refuses anyone but the owner.
 *   - Everything is scoped to ONE area: the owner's private "My files". Ids from the caller are checked to belong to that area
 *     (a foreign id gets the same "not found" as a missing one). No route, no client storage, no Business area.
 *   - "Shared with staff" (the folder staff can read) is READ-ONLY here: nothing is written, renamed, moved, trashed or restored
 *     into or out of it. A write there would publish a Claude-made file to staff.
 *   - No permanent delete exists. "Trash" is the store's own 90-day trash (restorable).
 *   - Every call writes an action_log row BEFORE it acts (untrusted_ai_content), then the outcome; hourly limits count those rows.
 */
import { randomUUID } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { saveBytesToStore, StoreFrozenFileError } from "./writer"
import { plainStoreError } from "./lock-errors"
import { effectiveKind, isLockedFolder, ownersAreaUserId } from "./structure"
import { storeNameKey } from "./rules"
import { checkDropContent, checkDropName, decodeDropContent, sha256Of } from "./my-files-drop-rules"
import {
  ACCESS_LIMITS, accessEnabled, accessRateRefusal, checkRenamedFile, clipText, isTextual, isUuid, parseIfExists, parseOptionalPath, parseFolderPath,
  type AccessKind,
} from "./my-files-access-rules"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* tables are not in the generated types
const db = () => supabaseAdmin as any

export interface AccessCaller { method: string; email: string }
export type AccessResult<T> = ({ ok: true } & T) | { ok: false; error: string }

/** A refusal that is safe and useful to show the caller as it is. Anything else becomes the generic INTERNAL text. */
class Refuse extends Error {}
const INTERNAL = "That could not be done right now. Nothing was changed; try again in a minute."
const NOT_FOUND = "Not found in My files."
const SHARE_REFUSAL = "\"Shared with staff\" is read-only for Claude: staff can read what is in it, so nothing may be written, renamed, moved or deleted there. Do that from the Storage page."

interface Area { ownerId: string; userId: string; rootId: string }
interface FolderRow { id: string; name: string; kind: string; parent_id: string | null; template_slug: string | null; owner_id: string; trashed_at: string | null }

async function resolveArea(): Promise<Area> {
  const userId = await ownersAreaUserId()
  if (!userId) throw new Refuse("The owner's login was not found, so there is no My files.")
  const { data: o, error } = await db().from("store_owners").select("id").eq("kind", "private").eq("private_user_id", userId).maybeSingle()
  if (error) throw new Error(`owner lookup: ${error.message}`)
  if (!o) throw new Refuse("The owner has no My files yet — open the Storage page once, then try again.")
  const { data: root, error: rErr } = await db().from("store_folders").select("id")
    .eq("owner_id", o.id).eq("kind", "private_root").is("parent_id", null).is("trashed_at", null).maybeSingle()
  if (rErr) throw new Error(`root lookup: ${rErr.message}`)
  if (!root) throw new Refuse("The My files top folder was not found.")
  return { ownerId: o.id as string, userId, rootId: root.id as string }
}

const FOLDER_COLS = "id, name, kind, parent_id, template_slug, owner_id, trashed_at"

/** The live child folder of `parentId` with this name (case-insensitive, like the store's own check), or null. */
async function childFolder(ownerId: string, parentId: string, name: string): Promise<FolderRow | null> {
  const { data, error } = await db().from("store_folders").select(FOLDER_COLS).eq("owner_id", ownerId).eq("parent_id", parentId).is("trashed_at", null).limit(1000)
  if (error) throw new Error(`folder lookup: ${error.message}`)
  const want = name.trim().toLowerCase()
  return ((data ?? []) as FolderRow[]).find((f) => f.name.trim().toLowerCase() === want) ?? null
}

async function folderRow(folderId: string): Promise<FolderRow | null> {
  const { data, error } = await db().from("store_folders").select(FOLDER_COLS).eq("id", folderId).maybeSingle()
  if (error) throw new Error(`folder lookup: ${error.message}`)
  return (data as FolderRow | null) ?? null
}

/** A live folder of THIS area by id, else a plain not-found. `top` allows the My files top itself. */
async function areaFolder(area: Area, folderId: unknown, opts: { top?: boolean } = {}): Promise<FolderRow> {
  if (!isUuid(folderId)) throw new Refuse("folder_id must be a folder id taken from my_files_list.")
  const f = await folderRow(folderId)
  if (!f || f.owner_id !== area.ownerId || f.trashed_at) throw new Refuse(NOT_FOUND)
  if (f.parent_id === null && !opts.top) throw new Refuse("That is the My files top folder itself.")
  return f
}

interface FileRow { id: string; name: string; owner_id: string; folder_id: string; state: string; caller_key: string | null }
async function areaFile(area: Area, fileId: unknown, opts: { allowTrashed?: boolean } = {}): Promise<FileRow> {
  if (!isUuid(fileId)) throw new Refuse("file_id must be a file id taken from my_files_list.")
  const { data, error } = await db().from("store_files").select("id, name, owner_id, folder_id, state, caller_key").eq("id", fileId).maybeSingle()
  if (error) throw new Error(`file lookup: ${error.message}`)
  const f = data as FileRow | null
  if (!f || f.owner_id !== area.ownerId || f.state === "purged") throw new Refuse(NOT_FOUND)
  if (f.state !== "live" && !opts.allowTrashed) throw new Refuse("That file is in the trash. Restore it first (my_files_trash_list, my_files_restore).")
  return f
}

/** Is this folder "Shared with staff" or inside it? (read-only here) */
async function inShare(folderId: string): Promise<boolean> {
  return (await effectiveKind(folderId)) === "staff_share"
}

/** Walk a path from the top through EXISTING folders. `hitShare` is true when the walk enters "Shared with staff". */
async function walk(area: Area, segments: string[]): Promise<{ existing: FolderRow | null; consumed: number; hitShare: boolean }> {
  let cur: FolderRow | null = await folderRow(area.rootId)
  let consumed = 0
  let hitShare = false
  for (const seg of segments) {
    const next = cur ? await childFolder(area.ownerId, cur.id, seg) : null
    if (!next) break
    cur = next
    consumed++
    if (next.kind === "staff_share") hitShare = true
  }
  return { existing: cur, consumed, hitShare }
}

/** The folder for a path, created if `create`; never inside "Shared with staff". */
async function folderForPath(area: Area, segments: string[], create: boolean, forWrite: boolean): Promise<FolderRow> {
  const w = await walk(area, segments)
  if (w.hitShare && forWrite) throw new Refuse(SHARE_REFUSAL)
  if (w.consumed === segments.length && w.existing) return w.existing
  if (!create) throw new Refuse(`The folder "${segments.join("/")}" does not exist in My files.`)
  const rest = segments.slice(w.consumed)
  const { data: id, error } = await db().rpc("store_ensure_folder_path", { p_owner: area.ownerId, p_parent: w.existing!.id, p_path: rest, p_actor: null })
  if (error || !id) throw new Error(`ensure folder: ${error?.message ?? "no id"}`)
  const made = await folderRow(id as string)
  if (!made || made.owner_id !== area.ownerId) throw new Error("ensure folder: the new folder is not in My files")
  if (forWrite && (await inShare(made.id))) throw new Refuse(SHARE_REFUSAL)
  return made
}

/** "Plans/2026" from the real folder chain, without the My files top. */
async function relPath(folderId: string): Promise<string> {
  const names: string[] = []
  let cur: string | null = folderId
  for (let i = 0; i < 50 && cur; i++) {
    const f = await folderRow(cur)
    if (!f) break
    if (f.parent_id) names.unshift(f.name)
    cur = f.parent_id
  }
  return names.join("/")
}

// ────────────────────────────────────────────────────────────── audit + limits

/** Caller text goes into the audit row only in a short form (a huge string must not bloat the log). */
const clip = (v: unknown): unknown => (typeof v === "string" ? v.slice(0, 300) : v ?? null)

const ACTION_TYPE: Record<AccessKind, string> = { read: "my_files_read", change: "my_files_change" }

async function usedLastHour(kind: AccessKind): Promise<number> {
  const since = new Date(Date.now() - 3600_000).toISOString()
  const { count, error } = await db().from("action_log").select("id", { count: "exact", head: true }).eq("action_type", ACTION_TYPE[kind]).gte("created_at", since)
  if (error) throw new Error(`usage count: ${error.message}`)
  return Number(count ?? 0)
}

async function bytesWrittenLastHour(): Promise<number> {
  const since = new Date(Date.now() - 3600_000).toISOString()
  const { data, error } = await db().from("action_log").select("details").eq("action_type", ACTION_TYPE.change).gte("created_at", since).limit(1000)
  if (error) throw new Error(`usage bytes: ${error.message}`)
  return ((data ?? []) as Array<{ details: { size?: number | string } | null }>).reduce((n, r) => n + (Number(r.details?.size ?? 0) || 0), 0)
}

interface Run { caller: AccessCaller; tool: string; kind: AccessKind; summary: string; detail: Record<string, unknown>; recordId?: string | null; extraBytes?: number }

type Note = (extra: Record<string, unknown>) => void

/**
 * Switch → audit row → limit → the action → outcome on the audit row. The audit row is written FIRST and the limits count it (and the bytes it declares),
 * so parallel calls cannot all pass the same count. A failed audit insert stops the action (no log, no action).
 */
async function guarded<T>(r: Run, act: (note: Note) => Promise<T>): Promise<AccessResult<T extends object ? T : never>> {
  if (!accessEnabled()) return { ok: false, error: "My files access is switched off. It is turned on with the setting MY_FILES_ACCESS_ENABLED=1." }
  let logId: string | null = null
  try {
    const base = { tool: r.tool, auth_method: r.caller.method, caller_email: r.caller.email, untrusted_ai_content: true, ...r.detail }
    const { data: ins, error: iErr } = await db().from("action_log").insert({
      actor: "claude.mcp", action_type: ACTION_TYPE[r.kind], table_name: "store_files", record_id: r.recordId ?? null,
      summary: `${r.tool}: ${r.summary}`, details: { ...base, outcome: "started" },
    }).select("id").single()
    if (iErr || !ins) throw new Error(`audit insert: ${iErr?.message ?? "no row"}`)
    logId = ins.id as string
    const extra: Record<string, unknown> = {}
    const finish = async (outcome: string) => {
      const { error } = await db().from("action_log").update({ details: { ...base, ...extra, outcome } }).eq("id", logId)
      if (error) console.error("[my-files-access] AUDIT OUTCOME NOT WRITTEN:", error.message)
    }
    // the count includes this call's own row
    const limited = accessRateRefusal(r.kind, (await usedLastHour(r.kind)) - 1)
    if (limited) { await finish(`refused: ${limited}`); return { ok: false, error: limited } }
    if (r.extraBytes) {
      const used = await bytesWrittenLastHour() // includes this call's declared size
      if (used > ACCESS_LIMITS.writeBytesPerHour) {
        const msg = `Too much written in the last hour (${ACCESS_LIMITS.writeBytesPerHour / 1048576} MB allowed). Wait a while.`
        await finish(`refused: ${msg}`)
        return { ok: false, error: msg }
      }
    }
    try {
      const out = await act((e) => Object.assign(extra, e))
      for (const k of ["file_id", "folder_id", "batch_id"]) if (out && typeof out === "object" && k in out) extra[`result_${k}`] = (out as Record<string, unknown>)[k]
      await finish("done")
      return { ok: true, ...(out as object) } as AccessResult<T extends object ? T : never>
    } catch (e) {
      await finish(e instanceof Refuse ? `refused: ${e.message}` : "failed")
      throw e
    }
  } catch (e) {
    if (e instanceof Refuse) return { ok: false, error: e.message }
    console.error(`[my-files-access] ${r.tool} failed:`, e instanceof Error ? e.message : e) // the real reason stays in the server log
    return { ok: false, error: INTERNAL }
  }
}

// ────────────────────────────────────────────────────────────── reads

export interface ListEntry { type: "folder" | "file"; id: string; name: string; kind?: string; locked?: boolean; size?: number | null; mime_type?: string | null; updated_at?: string }
export async function listMyFiles(input: { path?: unknown; folder_id?: unknown }, caller: AccessCaller): Promise<AccessResult<{ folder: string; folder_id: string; read_only: boolean; entries: ListEntry[]; truncated: boolean }>> {
  return guarded({ caller, tool: "my_files_list", kind: "read", summary: "list a folder", detail: { path: clip(input.path), folder_id: clip(input.folder_id) } }, async () => {
    const area = await resolveArea()
    let folder: FolderRow
    if (input.folder_id !== undefined && input.folder_id !== null) folder = await areaFolder(area, input.folder_id, { top: true })
    else {
      const p = parseOptionalPath(input.path)
      if (p.ok === false) throw new Refuse(p.error)
      folder = await folderForPath(area, p.segments, false, false)
    }
    const max = ACCESS_LIMITS.maxListEntries
    const { data: subs, error: sErr } = await db().from("store_folders").select(FOLDER_COLS).eq("parent_id", folder.id).is("trashed_at", null).order("name").limit(max + 1)
    if (sErr) throw new Error(`list folders: ${sErr.message}`)
    const { data: files, error: fErr } = await db().from("store_files")
      .select("id, name, updated_at, store_file_versions!store_files_current_version_fk(size_bytes, mime_type)")
      .eq("folder_id", folder.id).eq("state", "live").order("name").order("id").limit(max + 1)
    if (fErr) throw new Error(`list files: ${fErr.message}`)
    const entries: ListEntry[] = [
      ...((subs ?? []) as FolderRow[]).map((f) => ({ type: "folder" as const, id: f.id, name: f.name, kind: f.kind, locked: isLockedFolder(f) })),
      ...((files ?? []) as Array<{ id: string; name: string; updated_at: string; store_file_versions: { size_bytes: number | null; mime_type: string | null } | null }>)
        .map((f) => ({ type: "file" as const, id: f.id, name: f.name, size: f.store_file_versions?.size_bytes ?? null, mime_type: f.store_file_versions?.mime_type ?? null, updated_at: f.updated_at })),
    ]
    return { folder: await relPath(folder.id) || "(top)", folder_id: folder.id, read_only: await inShare(folder.id), entries: entries.slice(0, max), truncated: entries.length > max }
  })
}

export async function readMyFile(input: { file_id?: unknown; as_base64?: unknown }, caller: AccessCaller): Promise<AccessResult<{ name: string; folder: string; size: number; mime_type: string | null; encoding: "text" | "base64"; content: string; cut: boolean }>> {
  return guarded({ caller, tool: "my_files_read", kind: "read", summary: "read a file", detail: { file_id: clip(input.file_id) }, recordId: isUuid(input.file_id) ? input.file_id : null }, async () => {
    const area = await resolveArea()
    const f = await areaFile(area, input.file_id)
    const { data: cur, error: sErr } = await db().from("store_files").select("store_file_versions!store_files_current_version_fk(size_bytes)").eq("id", f.id).maybeSingle()
    if (sErr) throw new Error(`size lookup: ${sErr.message}`)
    const size = Number((cur?.store_file_versions as { size_bytes: number | null } | null)?.size_bytes ?? 0)
    if (size > ACCESS_LIMITS.maxReadBytes) throw new Refuse(`"${f.name}" is ${(size / 1048576).toFixed(1)} MB — too big to read from here (limit ${ACCESS_LIMITS.maxReadBytes / 1048576} MB). Open it on the Storage page.`)
    const { readFileForStaff } = await import("./browse")
    const got = await readFileForStaff(f.id)
    const wantB64 = input.as_base64 === true
    if (!wantB64 && isTextual(f.name, got.mimeType)) {
      const raw = got.bytes.toString("utf8")
      const c = clipText(raw)
      return { name: f.name, folder: await relPath(f.folder_id), size: got.bytes.length, mime_type: got.mimeType, encoding: "text" as const, content: c.text, cut: c.cut }
    }
    if (!wantB64) throw new Refuse(`"${f.name}" is a binary file (${got.bytes.length} bytes). Ask again with as_base64: true (files up to ${ACCESS_LIMITS.maxReadBase64Bytes / 1048576} MB).`)
    if (got.bytes.length > ACCESS_LIMITS.maxReadBase64Bytes) throw new Refuse(`"${f.name}" is ${(got.bytes.length / 1048576).toFixed(1)} MB — too big to hand back (limit ${ACCESS_LIMITS.maxReadBase64Bytes / 1048576} MB). Open it on the Storage page.`)
    return { name: f.name, folder: await relPath(f.folder_id), size: got.bytes.length, mime_type: got.mimeType, encoding: "base64" as const, content: got.bytes.toString("base64"), cut: false }
  })
}

// ────────────────────────────────────────────────────────────── writes

export async function writeMyFile(input: { path?: unknown; name?: unknown; text?: unknown; content_base64?: unknown; if_exists?: unknown }, caller: AccessCaller): Promise<AccessResult<{ status: "created" | "versioned" | "unchanged"; path: string; name: string; file_id: string; size: number; sha256_prefix: string; note: string }>> {
  const mode = parseIfExists(input.if_exists)
  if (mode === null) return { ok: false, error: "if_exists must be refuse, new_version or copy." }
  const p = parseOptionalPath(input.path)
  if (p.ok === false) return { ok: false, error: p.error }
  const nm = checkDropName(input.name)
  if (nm.ok === false) return { ok: false, error: nm.error }
  const body = decodeDropContent(input.text, input.content_base64)
  if (body.ok === false) return { ok: false, error: body.error }
  const content = checkDropContent(nm.ext, body.bytes)
  if (content.ok === false) return { ok: false, error: content.error }
  const bytes = body.bytes
  const sha = sha256Of(bytes)
  return guarded({ caller, tool: "my_files_write", kind: "change", summary: `write "${nm.name}" (${mode})`, detail: { path: p.segments.join("/"), name: nm.name, size: bytes.length, sha256: sha, if_exists: mode }, extraBytes: bytes.length }, async () => {
    const area = await resolveArea()
    const folder = await folderForPath(area, p.segments, true, true)
    const { data: same, error } = await db().from("store_files").select("id, name, caller_key, state").eq("folder_id", folder.id).eq("name_key", storeNameKey(nm.name)).neq("state", "purged")
    if (error) throw new Error(`same-name lookup: ${error.message}`)
    const rows = (same ?? []) as Array<{ id: string; name: string; caller_key: string | null; state: string }>
    const live = rows.find((r) => r.state === "live")
    let callerKey = `my-files-access:${randomUUID()}`
    let contentChanged = false
    if (live) {
      if (mode === "refuse") throw new Refuse(`"${nm.name}" already exists in this folder. Send if_exists "new_version" to add a new version of it, or "copy" to save this one as "name (2)".`)
      if (mode === "new_version") {
        if (!live.caller_key) throw new Refuse(`"${nm.name}" cannot take a new version from here (it was made by hand). Send if_exists "copy" or use another name.`)
        callerKey = live.caller_key
        contentChanged = true
      }
    }
    let res
    try {
      res = await saveBytesToStore({
        ownerId: area.ownerId, folderId: folder.id, name: nm.name, mimeType: nm.mime, callerKey, contentChanged,
        published: false, actor: null, documentType: null, skipAnalysis: true, bytes,
        facts: [{ key: "saved_by", value: "Claude session via MCP my_files_write — untrusted AI-session content, not reviewed", source: "rule" }],
      })
    } catch (e) {
      if (e instanceof StoreFrozenFileError) throw new Refuse("That file is marked as filed and cannot be changed.")
      // a file that takes no new version (signed, passport/ID, replaced, amended) is a plain refusal, never a generic internal error
      if (e instanceof Error && e.name === "StoreLockedFileError") throw new Refuse(`${plainStoreError(e)} Send if_exists "copy" or use another name.`)
      throw e
    }
    if (res.status === "trashed") throw new Refuse("That file was deleted from Storage earlier. Use another name.")
    if (res.status !== "created" && res.status !== "versioned" && res.status !== "unchanged") throw new Error(`unexpected write status ${res.status}`)
    const where = await relPath(folder.id)
    const note = res.status === "created" ? (res.name !== nm.name ? `A file named "${nm.name}" already existed, so this one was saved as "${res.name}".` : "Saved.")
      : res.status === "versioned" ? "Saved as a new version; the earlier version is kept in the file's history." : "The file already had exactly this content; nothing changed."
    return { status: res.status, path: where ? `${where}/${res.name}` : res.name, name: res.name, file_id: res.fileId, size: bytes.length, sha256_prefix: sha.slice(0, 12), note }
  })
}

export async function newMyFolder(input: { path?: unknown }, caller: AccessCaller): Promise<AccessResult<{ path: string; folder_id: string; note: string }>> {
  const p = parseFolderPath(input.path)
  if (p.ok === false) return { ok: false, error: p.error }
  return guarded({ caller, tool: "my_files_new_folder", kind: "change", summary: `make folder "${p.segments.join("/")}"`, detail: { path: p.segments.join("/") } }, async () => {
    const area = await resolveArea()
    const before = await walk(area, p.segments)
    const existed = before.consumed === p.segments.length && !before.hitShare
    const f = await folderForPath(area, p.segments, true, true)
    return { path: await relPath(f.id), folder_id: f.id, note: existed ? "The folder already existed." : "Folder ready." }
  })
}

/** The one thing renamed / moved / trashed: a file or a folder, never both, always in this area and outside "Shared with staff". */
async function target(area: Area, input: { file_id?: unknown; folder_id?: unknown }): Promise<{ kind: "file"; file: FileRow } | { kind: "folder"; folder: FolderRow }> {
  const hasF = input.file_id !== undefined && input.file_id !== null
  const hasD = input.folder_id !== undefined && input.folder_id !== null
  if (hasF === hasD) throw new Refuse("Send exactly one of file_id or folder_id.")
  if (hasF) {
    const file = await areaFile(area, input.file_id)
    if (await inShare(file.folder_id)) throw new Refuse(SHARE_REFUSAL)
    return { kind: "file", file }
  }
  const folder = await areaFolder(area, input.folder_id)
  if (folder.kind === "staff_share" || (await inShare(folder.id))) throw new Refuse(SHARE_REFUSAL)
  return { kind: "folder", folder }
}

export async function renameMyItem(input: { file_id?: unknown; folder_id?: unknown; new_name?: unknown }, caller: AccessCaller): Promise<AccessResult<{ name: string; note: string }>> {
  if (typeof input.new_name !== "string" || !input.new_name.trim()) return { ok: false, error: "new_name is required." }
  const newName = input.new_name
  return guarded({ caller, tool: "my_files_rename", kind: "change", summary: "rename", detail: { file_id: clip(input.file_id), folder_id: clip(input.folder_id), new_name: clip(newName) } }, async (note) => {
    const area = await resolveArea()
    const t = await target(area, input)
    note({ before_name: t.kind === "file" ? t.file.name : t.folder.name })
    try {
      if (t.kind === "file") {
        const chk = checkRenamedFile(newName, t.file.name)
        if (chk.ok === false) throw new Refuse(chk.error)
        const { renameStoreFile } = await import("./file-actions")
        const r = await renameStoreFile(t.file.id, chk.name, null)
        return { name: r.name, note: "Renamed." }
      }
      const fn = parseFolderPath(newName)
      if (fn.ok === false || fn.segments.length !== 1) throw new Refuse("new_name must be one folder name (no slashes).")
      const { renameFolder } = await import("./structure")
      const r = await renameFolder(t.folder.id, fn.segments[0], null)
      return { name: r.name, note: "Renamed." }
    } catch (e) {
      if (e instanceof Refuse) throw e
      throw new Refuse(e instanceof Error ? e.message : INTERNAL) // the store's own plain messages ("already exists here", "fixed folders can't be renamed")
    }
  })
}

export async function moveMyItem(input: { file_id?: unknown; folder_id?: unknown; to_path?: unknown }, caller: AccessCaller): Promise<AccessResult<{ to: string; note: string }>> {
  const p = parseOptionalPath(input.to_path)
  if (p.ok === false) return { ok: false, error: p.error }
  return guarded({ caller, tool: "my_files_move", kind: "change", summary: `move to "${p.segments.join("/") || "(top)"}"`, detail: { file_id: clip(input.file_id), folder_id: clip(input.folder_id), to_path: p.segments.join("/") } }, async (note) => {
    const area = await resolveArea()
    const t = await target(area, input)
    if (t.kind === "file") note({ before_name: t.file.name, before_folder_id: t.file.folder_id })
    else {
      note({ before_name: t.folder.name, before_folder_id: t.folder.parent_id })
      // refuse BEFORE a destination is created: a fixed folder, or a destination inside the folder itself
      if (isLockedFolder(t.folder)) throw new Refuse(`"${t.folder.name}" is one of the fixed folders and can't be moved.`)
      const mine = (await relPath(t.folder.id)).toLowerCase()
      const to = p.segments.join("/").toLowerCase()
      if (to === mine || to.startsWith(`${mine}/`)) throw new Refuse("A folder can't go inside itself.")
    }
    const dest = await folderForPath(area, p.segments, true, true)
    try {
      if (t.kind === "file") {
        const { moveStoreFile } = await import("./file-actions")
        await moveStoreFile(t.file.id, dest.id, null)
      } else {
        const { moveFolder } = await import("./structure")
        await moveFolder(t.folder.id, dest.id, null)
      }
    } catch (e) {
      throw new Refuse(e instanceof Error ? e.message : INTERNAL)
    }
    return { to: (await relPath(dest.id)) || "(top)", note: "Moved." }
  })
}

// ────────────────────────────────────────────────────────────── trash + restore (never a permanent delete)

export async function trashMyItem(input: { file_id?: unknown; folder_id?: unknown }, caller: AccessCaller): Promise<AccessResult<{ trashed: string; batch_id: string | null; note: string }>> {
  return guarded({ caller, tool: "my_files_trash", kind: "change", summary: "move to trash", detail: { file_id: clip(input.file_id), folder_id: clip(input.folder_id) } }, async (note) => {
    const area = await resolveArea()
    const t = await target(area, input)
    note({ before_name: t.kind === "file" ? t.file.name : t.folder.name, before_folder_id: t.kind === "file" ? t.file.folder_id : t.folder.parent_id })
    try {
      if (t.kind === "file") {
        const { deleteStoreFile } = await import("./file-actions")
        await deleteStoreFile(t.file.id, area.userId) // the store's trash needs a real login as the actor: the owner's
        const { data } = await db().from("store_files").select("trash_batch_id").eq("id", t.file.id).maybeSingle()
        return { trashed: t.file.name, batch_id: (data?.trash_batch_id as string | null) ?? null, note: "Moved to the trash. It can be restored for 90 days (my_files_restore)." }
      }
      if (isLockedFolder(t.folder)) throw new Refuse(`"${t.folder.name}" is one of the fixed folders and can't be deleted.`)
      const { filesUnder, deleteFolder } = await import("./structure")
      const n = (await filesUnder(t.folder.id)).length
      if (n > ACCESS_LIMITS.maxTrashFolderFiles) throw new Refuse(`"${t.folder.name}" holds ${n} files — more than ${ACCESS_LIMITS.maxTrashFolderFiles}. Trash it from the Storage page.`)
      await deleteFolder(t.folder.id, area.userId)
      const { data } = await db().from("store_folders").select("trash_batch_id").eq("id", t.folder.id).maybeSingle()
      return { trashed: t.folder.name, batch_id: (data?.trash_batch_id as string | null) ?? null, note: `Moved to the trash with ${n} file${n === 1 ? "" : "s"}. It can be restored for 90 days (my_files_restore).` }
    } catch (e) {
      if (e instanceof Refuse) throw e
      throw new Refuse(e instanceof Error ? e.message : INTERNAL)
    }
  })
}

export interface TrashEntry { batch_id: string; name: string | null; files: number; folders: number; trashed_at: string; restorable_until: string }
export async function trashListMy(caller: AccessCaller): Promise<AccessResult<{ entries: TrashEntry[] }>> {
  return guarded({ caller, tool: "my_files_trash_list", kind: "read", summary: "list the trash", detail: {} }, async () => {
    const area = await resolveArea()
    const { data, error } = await db().rpc("store_trash_list", { p_owner_id: area.ownerId })
    if (error) throw new Error(`trash list: ${error.message}`)
    const rows = (data ?? []) as Array<{ batch_id: string; top_name: string | null; files: number | string; folders: number | string; trashed_at: string; purge_after: string }>
    return { entries: rows.slice(0, ACCESS_LIMITS.maxListEntries).map((r) => ({ batch_id: r.batch_id, name: r.top_name, files: Number(r.files), folders: Number(r.folders), trashed_at: r.trashed_at, restorable_until: r.purge_after })) }
  })
}

export async function restoreMy(input: { batch_id?: unknown }, caller: AccessCaller): Promise<AccessResult<{ restored: Array<{ kind: string; name: string; renamed: boolean }>; skipped: Array<{ name: string; why: string }>; note: string }>> {
  if (!isUuid(input.batch_id)) return { ok: false, error: "batch_id must be a batch id taken from my_files_trash_list." }
  const batchId = input.batch_id
  return guarded({ caller, tool: "my_files_restore", kind: "change", summary: "restore from trash", detail: { batch_id: clip(batchId) } }, async () => {
    const area = await resolveArea()
    const { data: list, error } = await db().rpc("store_trash_list", { p_owner_id: area.ownerId })
    if (error) throw new Error(`trash list: ${error.message}`)
    if (!((list ?? []) as Array<{ batch_id: string }>).some((b) => b.batch_id === batchId)) throw new Refuse("That trash entry is not in My files (or has already been restored).")
    // nothing comes back INTO "Shared with staff": staff would suddenly be able to read it
    const { data: fRows, error: e1 } = await db().from("store_files").select("folder_id").eq("trash_batch_id", batchId).limit(2000)
    const { data: dRows, error: e2 } = await db().from("store_folders").select("id, parent_id").eq("trash_batch_id", batchId).limit(2000)
    if (e1 || e2) throw new Error(`batch lookup: ${(e1 ?? e2).message}`)
    const places = new Set<string>([...((fRows ?? []) as Array<{ folder_id: string }>).map((r) => r.folder_id), ...((dRows ?? []) as Array<{ parent_id: string | null }>).map((r) => r.parent_id).filter((x): x is string => !!x)])
    for (const id of Array.from(places)) if (await inShare(id)) throw new Refuse(SHARE_REFUSAL)
    const { data, error: rErr } = await db().rpc("store_restore_batch", { p_batch_id: batchId, p_actor: area.userId, p_target_folder: null })
    if (rErr) throw new Refuse(rErr.message.replace(/^store: /, ""))
    const rep = data as { restored?: Array<{ kind: string; name: string; renamed: boolean }>; skipped?: Array<{ name: string; why: string }> }
    return { restored: rep.restored ?? [], skipped: rep.skipped ?? [], note: "Restored to where it was." }
  })
}
