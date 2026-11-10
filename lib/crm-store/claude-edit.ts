/**
 * Claude EDITS a file in Storage (dev job bd21e833, master plan Part 54, step 2) — the server half behind the MCP tools
 * `store_find_files / store_open_file / store_edit_file / store_save_file / store_upload_url`. The pure rules are in `claude-edit-rules.ts`.
 *
 * It is built ON the safe save of step 1 (`appendVersionBytes` → database function `store_append_version`), so every rule of that save applies
 * to Claude exactly as to a person on the web page, and the database enforces it, not this file:
 *   - every saved change is the NEXT numbered version; the old copy stays under "older copies" (nothing is overwritten or deleted)
 *   - a signed document, a passport / ID, a replaced file and a filed return are never changed ("locked" / "frozen")
 *   - an amended return needs a person's confirmation and a typed reason: Claude can never give one, so it is refused (the word of the person
 *     on the Storage page is the only way)
 *   - the change names the version it started from: if the file changed meanwhile, Claude's change is kept as a hidden "not applied" version
 *     with a short banner, and the current copy is not touched
 *   - a file the CLIENT can see is never changed behind the client's back: Claude's change waits as a PROPOSED (not applied) version until
 *     a person accepts it on the Storage page (and chooses visible or hidden), or discards it
 *
 * The same boundaries as `my-files-access.ts` (it shares its guard): OFF unless MY_FILES_ACCESS_ENABLED=1; the MCP layer already refuses anyone
 * but the owner; every call writes an action_log row BEFORE it acts; hourly limits count those rows. Reach: Business, company, person and
 * formation storages that are LIVE (never a hidden study copy), and the owner's own My files (never "Shared with staff", which is read-only
 * for Claude). Other staff members' My files are never reachable.
 */
import { randomUUID } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { appendVersionBytes, INLINE_REGISTER_MAX_BYTES, sha256Hex, STORE_BUCKET } from "./writer"
import { effectiveKind, ownersAreaUserId } from "./structure"
import { storePointer } from "./document-pointer"
import { checkReplacement, conflictText, lockText, statusMessage } from "./new-version-rules"
import { ACCESS_LIMITS, clipText, isTextual, isUuid } from "./my-files-access-rules"
import { guarded, Refuse, clip, type AccessCaller, type AccessResult } from "./my-files-access"
import {
  applyTextEdits, CLAUDE_EDIT_PREFIX, CONFLICT_PREFIX, describeChange, describeWholeFile, PROPOSAL_PREFIX, versionNote,
} from "./claude-edit-rules"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- store_* tables are not in the generated types
const db = () => supabaseAdmin as any

const STAGING_BUCKET = "onboarding-uploads"
const CLAUDE_STAGING_PREFIX = "crm-uploads/store-staging/claude/"
const REACH_KINDS = new Set(["business", "company", "person", "formation"])
const NOT_REACHABLE = "That file was not found, or it is not one Claude may change (a hidden study copy, someone else's My files, or the \"Shared with staff\" folder)."
const AMENDED_REFUSAL = (name: string) => `"${name}" is an amended return. Changing it needs a person's confirmation and a typed reason on the Storage page ("Upload edited version") — Claude cannot give either, so nothing was changed.`

interface OwnerRow { kind: string; study_only: boolean | null; account_id: string | null; contact_id: string | null; private_user_id: string | null }
interface FileInfo {
  id: string; name: string; ownerId: string; folderId: string; where: string; clientVisible: boolean
  currentVersionNo: number | null; size: number | null; mimeType: string | null; bucket: string | null; path: string | null
}

/** "Company X" / "Person Y" / "Business" / "My files" for a set of owners, in two small reads. */
async function ownerLabels(owners: Array<{ id: string } & OwnerRow>): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const accountIds = Array.from(new Set(owners.map((o) => o.account_id).filter((x): x is string => !!x)))
  const contactIds = Array.from(new Set(owners.map((o) => o.contact_id).filter((x): x is string => !!x)))
  const names = new Map<string, string>()
  if (accountIds.length) {
    const { data, error } = await db().from("accounts").select("id, company_name").in("id", accountIds)
    if (error) throw new Error(`label lookup: ${error.message}`)
    for (const a of (data ?? []) as Array<{ id: string; company_name: string | null }>) names.set(`a:${a.id}`, a.company_name ?? "a company")
  }
  if (contactIds.length) {
    const { data, error } = await db().from("contacts").select("id, full_name").in("id", contactIds)
    if (error) throw new Error(`label lookup: ${error.message}`)
    for (const c of (data ?? []) as Array<{ id: string; full_name: string | null }>) names.set(`c:${c.id}`, c.full_name ?? "a person")
  }
  for (const o of owners) {
    out.set(o.id, o.kind === "company" || o.kind === "formation" ? `Company: ${names.get(`a:${o.account_id}`) ?? "(no name)"}`
      : o.kind === "person" ? `Person: ${names.get(`c:${o.contact_id}`) ?? "(no name)"}`
      : o.kind === "business" ? "Business" : "My files")
  }
  return out
}

async function folderPath(folderId: string): Promise<string> {
  const names: string[] = []
  let cur: string | null = folderId
  for (let i = 0; i < 50 && cur; i++) {
    const { data, error } = await db().from("store_folders").select("id, name, parent_id").eq("id", cur).maybeSingle()
    if (error) throw new Error(`folder path: ${error.message}`)
    if (!data) break
    if (data.parent_id) names.unshift(data.name as string)
    cur = (data.parent_id as string | null) ?? null
  }
  return names.join("/") || "(top)"
}

/** Is the file in front of a client now? (a CRM document row that is visible, or the store's own published mark) */
async function visibleToClient(fileId: string, published: boolean | null): Promise<boolean> {
  if (published === true) return true
  const { data, error } = await db().from("documents").select("portal_visible").eq("drive_file_id", storePointer(fileId)).limit(20)
  if (error) throw new Error(`visibility lookup: ${error.message}`)
  return ((data ?? []) as Array<{ portal_visible: boolean | null }>).some((r) => r.portal_visible === true)
}

/** A live file Claude may change, or a plain refusal (a foreign id gets the same answer as a missing one). */
async function reachableFile(fileId: unknown): Promise<FileInfo> {
  if (!isUuid(fileId)) throw new Refuse("file_id must be a file id taken from store_find_files.")
  const { data, error } = await db().from("store_files")
    .select("id, name, owner_id, folder_id, state, published, store_owners(kind, study_only, account_id, contact_id, private_user_id), store_file_versions!store_files_current_version_fk(version_no, size_bytes, mime_type, storage_bucket, storage_path)")
    .eq("id", fileId).maybeSingle()
  if (error) throw new Error(`file lookup: ${error.message}`)
  const f = data as (Record<string, unknown> & { store_owners: OwnerRow | null; store_file_versions: { version_no: number | null; size_bytes: number | null; mime_type: string | null; storage_bucket: string | null; storage_path: string | null } | null }) | null
  if (!f || f.state === "purged") throw new Refuse(NOT_REACHABLE)
  const o = f.store_owners
  if (!o) throw new Refuse(NOT_REACHABLE)
  if (f.state !== "live") throw new Refuse(`"${f.name as string}" is in the trash. Restore it from the Storage page first.`)
  if (o.kind === "private") {
    const mine = await ownersAreaUserId()
    if (!mine || o.private_user_id !== mine) throw new Refuse(NOT_REACHABLE)
    if ((await effectiveKind(f.folder_id as string)) === "staff_share") throw new Refuse(NOT_REACHABLE)
  } else if (!REACH_KINDS.has(o.kind) || o.study_only === true) throw new Refuse(NOT_REACHABLE)
  const v = f.store_file_versions
  const labels = await ownerLabels([{ id: f.owner_id as string, ...o }])
  return {
    id: f.id as string, name: f.name as string, ownerId: f.owner_id as string, folderId: f.folder_id as string, where: labels.get(f.owner_id as string) ?? "Storage",
    clientVisible: await visibleToClient(f.id as string, (f.published as boolean | null) ?? null),
    currentVersionNo: v?.version_no ?? null, size: v?.size_bytes ?? null, mimeType: v?.mime_type ?? null, bucket: v?.storage_bucket ?? null, path: v?.storage_path ?? null,
  }
}

async function lockKind(fileId: string): Promise<string | null> {
  const { data, error } = await db().rpc("store_lock_class", { p_file_id: fileId })
  if (error) throw new Error(`lock lookup: ${error.message}`)
  return (data as string | null) || null
}

async function readVersionBytes(fileId: string, versionNo: number): Promise<{ bytes: Buffer; mimeType: string | null }> {
  const { data: v, error } = await db().from("store_file_versions").select("storage_bucket, storage_path, mime_type, size_bytes").eq("file_id", fileId).eq("version_no", versionNo).maybeSingle()
  if (error) throw new Error(`version lookup: ${error.message}`)
  if (!v) throw new Refuse(`Version ${versionNo} of this file does not exist. Open the file again to get its current version number.`)
  if (Number(v.size_bytes ?? 0) > ACCESS_LIMITS.maxReadBytes) throw new Refuse(`That version is ${(Number(v.size_bytes) / 1048576).toFixed(0)} MB — too big to edit from here. Open it on the Storage page.`)
  const { data, error: dl } = await db().storage.from(v.storage_bucket ?? STORE_BUCKET).download(v.storage_path)
  if (dl || !data) throw new Error(`version download: ${dl?.message ?? "no data"}`)
  return { bytes: Buffer.from(await data.arrayBuffer()), mimeType: (v.mime_type as string | null) ?? null }
}

async function proposalsWaiting(fileId: string): Promise<number> {
  const { data, error } = await db().rpc("store_files_edit_info", { p_ids: [fileId] })
  if (error) return 0
  return Number((data as Array<{ unmerged_pending: number }> | null)?.[0]?.unmerged_pending ?? 0)
}

// ────────────────────────────────────────────────────────────── find / open

export interface FoundFile { file_id: string; name: string; where: string; folder: string; version_no: number | null; size: number | null; client_visible: boolean }

export async function findStoreFiles(input: { query?: unknown }, caller: AccessCaller): Promise<AccessResult<{ files: FoundFile[]; truncated: boolean }>> {
  return guarded({ caller, tool: "store_find_files", kind: "read", summary: "find files", detail: { query: clip(input.query) } }, async () => {
    const q = typeof input.query === "string" ? input.query.trim() : ""
    if (q.length < 2 || q.length > 100 || /[%_\\,()]/.test(q)) throw new Refuse("query must be 2 to 100 characters of plain text (part of a file name), without % _ \\ , ( ).")
    const { data, error } = await db().from("store_files")
      .select("id, name, folder_id, published, owner_id, store_owners(kind, study_only, account_id, contact_id, private_user_id), store_file_versions!store_files_current_version_fk(version_no, size_bytes)")
      .eq("state", "live").ilike("name", `%${q}%`).order("updated_at", { ascending: false }).limit(150)
    if (error) throw new Error(`find: ${error.message}`)
    const mine = await ownersAreaUserId()
    type Row = { id: string; name: string; folder_id: string; published: boolean | null; owner_id: string; store_owners: OwnerRow | null; store_file_versions: { version_no: number | null; size_bytes: number | null } | null }
    const rows = ((data ?? []) as Row[]).filter((r) => {
      const o = r.store_owners
      if (!o) return false
      if (o.kind === "private") return !!mine && o.private_user_id === mine
      return REACH_KINDS.has(o.kind) && o.study_only !== true
    })
    const shown: Row[] = []
    for (const r of rows) {
      if (r.store_owners?.kind === "private" && (await effectiveKind(r.folder_id)) === "staff_share") continue
      shown.push(r)
      if (shown.length >= 20) break
    }
    const labels = await ownerLabels(shown.map((r) => ({ id: r.owner_id, ...(r.store_owners as OwnerRow) })))
    const files: FoundFile[] = []
    for (const r of shown) {
      files.push({ file_id: r.id, name: r.name, where: labels.get(r.owner_id) ?? "Storage", folder: await folderPath(r.folder_id), version_no: r.store_file_versions?.version_no ?? null, size: r.store_file_versions?.size_bytes ?? null, client_visible: await visibleToClient(r.id, r.published) })
    }
    return { files, truncated: rows.length > shown.length }
  })
}

export interface OpenedFile {
  file_id: string; name: string; where: string; folder: string; version_no: number | null; size: number | null; mime_type: string | null
  client_visible: boolean; lock: string | null; proposals_waiting: number; edit_note: string
  encoding: "text" | "base64" | "none"; content: string | null; cut: boolean; download_url: string | null
}

export async function openStoreFile(input: { file_id?: unknown; as_base64?: unknown }, caller: AccessCaller): Promise<AccessResult<OpenedFile>> {
  return guarded({ caller, tool: "store_open_file", kind: "read", summary: "open a file", detail: { file_id: clip(input.file_id) }, recordId: isUuid(input.file_id) ? input.file_id : null }, async () => {
    const f = await reachableFile(input.file_id)
    const lock = await lockKind(f.id)
    const size = f.size ?? 0
    if (size > ACCESS_LIMITS.maxReadBytes) throw new Refuse(`"${f.name}" is ${(size / 1048576).toFixed(0)} MB — too big to open from here. Open it on the Storage page.`)
    const base = {
      file_id: f.id, name: f.name, where: f.where, folder: await folderPath(f.folderId), version_no: f.currentVersionNo, size: f.size, mime_type: f.mimeType,
      client_visible: f.clientVisible, lock, proposals_waiting: await proposalsWaiting(f.id),
      edit_note: lock === "signed" || lock === "replace_only" || lock === "replaced" || lock === "filed" ? lockText(lock === "filed" ? "filed" : lock, f.name)
        : lock === "amended" ? AMENDED_REFUSAL(f.name)
        : f.clientVisible ? "The client can see this file, so a change from Claude is saved as a PROPOSED version that a person accepts on the Storage page." : "A change from Claude is saved straight away as the next version.",
    }
    const { readFileForStaff } = await import("./browse")
    const got = await readFileForStaff(f.id)
    if (input.as_base64 !== true && isTextual(f.name, got.mimeType ?? f.mimeType)) {
      const c = clipText(got.bytes.toString("utf8"))
      return { ...base, encoding: "text" as const, content: c.text, cut: c.cut, download_url: null }
    }
    if (input.as_base64 === true && got.bytes.length <= ACCESS_LIMITS.maxReadBase64Bytes) return { ...base, encoding: "base64" as const, content: got.bytes.toString("base64"), cut: false, download_url: null }
    // a binary file (or a big one): a short-lived link instead of the bytes
    let url: string | null = null
    if (f.bucket && f.path) {
      const { data: signed, error } = await db().storage.from(f.bucket).createSignedUrl(f.path, 600)
      if (error) throw new Error(`download link: ${error.message}`)
      url = (signed?.signedUrl as string | undefined) ?? null
    }
    return { ...base, encoding: "none" as const, content: null, cut: false, download_url: url }
  })
}

// ────────────────────────────────────────────────────────────── save

export type SaveStatus = "saved" | "proposed" | "kept_not_applied" | "unchanged" | "refused"
export interface SaveReply { status: SaveStatus; version_no: number | null; message: string; summary: string; client_visible: boolean }

interface WriteArgs {
  file: FileInfo; bytes: Buffer; mimeType: string | null; baseVersionNo: number; summary: string; instruction: string | null
}

/** The ONE write path for both tools: proposal when the client can see the file, conflict kept as not-applied, amended refused. */
async function writeVersion(w: WriteArgs): Promise<SaveReply> {
  const f = w.file
  const base = { client_visible: f.clientVisible, summary: w.summary }
  const proposal = f.clientVisible
  const note = versionNote(proposal ? PROPOSAL_PREFIX : CLAUDE_EDIT_PREFIX, w.summary, w.instruction)
  const call = (unmerged: boolean, n: string) => appendVersionBytes({
    fileId: f.id, bytes: w.bytes, mimeType: w.mimeType, expectedVersionNo: w.baseVersionNo, actor: null, source: "claude", unmerged, note: n,
  })
  let res = await call(proposal, note)
  let conflicted = false
  if (res.status === "conflict") { conflicted = true; res = await call(true, versionNote(CONFLICT_PREFIX, w.summary, w.instruction)) } // the file moved on: keep Claude's change, hidden
  const name = res.name ?? f.name
  if (res.status === "versioned") return { ...base, status: "saved", version_no: res.versionNo ?? null, message: `Saved as version ${res.versionNo}. The previous copy is kept under "older copies".` }
  if (res.status === "unmerged") {
    return { ...base, status: conflicted ? "kept_not_applied" : "proposed", version_no: res.versionNo ?? null, message: !conflicted
      ? `The client can see "${name}", so this is saved as a PROPOSED change (version ${res.versionNo}, not applied). The current copy was not changed. A person accepts or discards it on the Storage page.`
      : `The file changed while it was being edited, so this change is kept as version ${res.versionNo} (not applied). The current copy was not changed. A person can apply it from the version list on the Storage page.` }
  }
  if (res.status === "needs_confirmation") return { ...base, status: "refused", version_no: null, message: AMENDED_REFUSAL(name) }
  if (res.status === "locked" || res.status === "frozen") return { ...base, status: "refused", version_no: null, message: lockText(res.status === "frozen" ? "filed" : res.kind, name) }
  if (res.status === "unchanged") return { ...base, status: "unchanged", version_no: res.versionNo ?? null, message: res.alreadyApplied ? `This change had already been saved (version ${res.versionNo}).` : statusMessage("unchanged", name) }
  if (res.status === "conflict") return { ...base, status: "refused", version_no: null, message: conflictText({ name, currentVersionNo: res.currentVersionNo }) }
  return { ...base, status: "refused", version_no: null, message: statusMessage(res.status, name) }
}

function checkBaseVersion(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Refuse("base_version_no must be the version number store_open_file gave you (a whole number, 1 or more).")
  return v
}
const cleanInstruction = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null)

export async function editStoreFile(input: { file_id?: unknown; base_version_no?: unknown; edits?: unknown; why?: unknown }, caller: AccessCaller): Promise<AccessResult<SaveReply>> {
  return guarded({ caller, tool: "store_edit_file", kind: "change", summary: "edit a text file", detail: { file_id: clip(input.file_id), base_version_no: input.base_version_no, edits: Array.isArray(input.edits) ? input.edits.length : null, why: clip(input.why) }, recordId: isUuid(input.file_id) ? input.file_id : null, extraBytes: 1 }, async (note) => {
    const base = checkBaseVersion(input.base_version_no)
    const f = await reachableFile(input.file_id)
    const lock = await lockKind(f.id)
    if (lock === "amended") throw new Refuse(AMENDED_REFUSAL(f.name))
    if (lock) throw new Refuse(lockText(lock, f.name))
    const { bytes: baseBytes, mimeType } = await readVersionBytes(f.id, base)
    if (!isTextual(f.name, mimeType ?? f.mimeType)) throw new Refuse(`"${f.name}" is not a text file, so it cannot be edited piece by piece. Save a whole new copy with store_save_file instead.`)
    const before = baseBytes.toString("utf8")
    const applied = applyTextEdits(before, input.edits)
    if (applied.ok === false) throw new Refuse(applied.error)
    const change = describeChange(before, applied.text)
    if (applied.text === before) return { status: "unchanged" as const, version_no: base, message: "The instructions leave the file exactly as it was, so nothing was saved.", summary: change.sentence, client_visible: f.clientVisible }
    const bytes = Buffer.from(applied.text, "utf8")
    note({ file_name: f.name, size: bytes.length, summary: change.sentence, client_visible: f.clientVisible })
    const r = await writeVersion({ file: f, bytes, mimeType, baseVersionNo: base, summary: change.sentence, instruction: cleanInstruction(input.why) })
    return { ...r, summary: change.sample.length ? `${change.sentence}: ${change.sample.join(" | ")}` : change.sentence }
  })
}

export async function saveStoreFile(input: { file_id?: unknown; base_version_no?: unknown; content_base64?: unknown; staged_path?: unknown; accept_warnings?: unknown; why?: unknown }, caller: AccessCaller): Promise<AccessResult<SaveReply>> {
  const declared = typeof input.content_base64 === "string" ? Math.ceil((input.content_base64.length * 3) / 4) : 0
  return guarded({ caller, tool: "store_save_file", kind: "change", summary: "save a whole new copy", detail: { file_id: clip(input.file_id), base_version_no: input.base_version_no, staged: clip(input.staged_path), why: clip(input.why) }, recordId: isUuid(input.file_id) ? input.file_id : null, extraBytes: declared || 1 }, async (note) => {
    const base = checkBaseVersion(input.base_version_no)
    const hasB64 = typeof input.content_base64 === "string" && input.content_base64.length > 0
    const hasStaged = typeof input.staged_path === "string" && input.staged_path.length > 0
    if (hasB64 === hasStaged) throw new Refuse("Send exactly one of content_base64 (up to 3 MB) or staged_path (from store_upload_url, for bigger files).")
    const f = await reachableFile(input.file_id)
    const lock = await lockKind(f.id)
    if (lock === "amended") throw new Refuse(AMENDED_REFUSAL(f.name))
    if (lock) throw new Refuse(lockText(lock, f.name))
    let bytes: Buffer
    let stagedPath: string | null = null
    if (hasB64) {
      if (declared > ACCESS_LIMITS.maxReadBase64Bytes + 4) throw new Refuse(`That is more than ${ACCESS_LIMITS.maxReadBase64Bytes / 1048576} MB. Use store_upload_url and send staged_path instead.`)
      bytes = Buffer.from(input.content_base64 as string, "base64")
      if (bytes.length === 0) throw new Refuse("content_base64 is empty or not valid base64.")
      if (bytes.length > ACCESS_LIMITS.maxReadBase64Bytes) throw new Refuse(`That is more than ${ACCESS_LIMITS.maxReadBase64Bytes / 1048576} MB. Use store_upload_url and send staged_path instead.`)
    } else {
      stagedPath = input.staged_path as string
      if (!stagedPath.startsWith(CLAUDE_STAGING_PREFIX) || stagedPath.includes("..")) throw new Refuse("staged_path must be the path store_upload_url gave you.")
      const slash = stagedPath.lastIndexOf("/")
      const { data: listed } = await db().storage.from(STAGING_BUCKET).list(stagedPath.slice(0, slash), { search: stagedPath.slice(slash + 1), limit: 5 })
      const size = ((listed ?? []) as Array<{ name: string; metadata?: { size?: number } | null }>).find((o) => o.name === stagedPath!.slice(slash + 1))?.metadata?.size
      if (typeof size !== "number") throw new Refuse("Nothing was found at that staged_path. Upload the file to the link first, then call this again.")
      if (size > INLINE_REGISTER_MAX_BYTES) { await db().storage.from(STAGING_BUCKET).remove([stagedPath]).catch(() => {}); throw new Refuse(`That file is ${(size / 1048576).toFixed(0)} MB — the limit for a new version is ${INLINE_REGISTER_MAX_BYTES / 1048576} MB.`) }
      const { data: blob, error } = await db().storage.from(STAGING_BUCKET).download(stagedPath)
      if (error || !blob) throw new Error(`staged download: ${error?.message ?? "no data"}`)
      bytes = Buffer.from(await blob.arrayBuffer())
    }
    const removeStaged = () => (stagedPath ? db().storage.from(STAGING_BUCKET).remove([stagedPath]).catch(() => {}) : Promise.resolve())
    try {
      const mime = (f.mimeType ?? "application/octet-stream")
      const chk = checkReplacement({ name: f.name, mimeType: f.mimeType, size: f.size }, { name: f.name, mimeType: mime, size: bytes.length })
      if (chk.block) throw new Refuse(chk.block)
      if (chk.warnings.length > 0 && input.accept_warnings !== true) {
        throw new Refuse(`Please check: ${chk.warnings.map((w) => (w === "much_smaller" ? "the new copy is much smaller than the current one" : "the type differs from the current file")).join(" and ")}. If that is right, send accept_warnings: true. Nothing was saved.`)
      }
      note({ file_name: f.name, size: bytes.length, sha256: sha256Hex(bytes).slice(0, 16), client_visible: f.clientVisible })
      const summary = describeWholeFile(f.size, bytes.length)
      return await writeVersion({ file: f, bytes, mimeType: mime, baseVersionNo: base, summary, instruction: cleanInstruction(input.why) })
    } finally { await removeStaged() }
  })
}

export async function uploadUrlForStoreFile(input: { file_id?: unknown }, caller: AccessCaller): Promise<AccessResult<{ upload_url: string; staged_path: string; expires: string; how: string }>> {
  return guarded({ caller, tool: "store_upload_url", kind: "read", summary: "ask for an upload link", detail: { file_id: clip(input.file_id) }, recordId: isUuid(input.file_id) ? input.file_id : null }, async () => {
    const f = await reachableFile(input.file_id)
    const path = `${CLAUDE_STAGING_PREFIX}${randomUUID()}/${f.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "file"}`
    const { data, error } = await db().storage.from(STAGING_BUCKET).createSignedUploadUrl(path)
    if (error || !data?.signedUrl) throw new Error(`upload link: ${error?.message ?? "no link"}`)
    return {
      upload_url: data.signedUrl as string, staged_path: path, expires: "about 2 hours",
      how: "Send the new file's bytes with an HTTP PUT to upload_url (header Content-Type: the file's type). Then call store_save_file with this staged_path and the base_version_no. An upload that is never saved is removed within a day.",
    }
  })
}

