/**
 * CRM Store — slice S4: trash / restore / purge / "remove from view" / folder upload / folder zip
 * (master plan v4.5 §8.6, §8.8, §8.9 #4; job 685467b5). Dark: nothing calls this yet and the purge
 * is NOT scheduled.
 *
 * The rules (who may restore where, the 90-day window, tombstones, the per-file privacy check of a
 * zip) live in the database — scripts/migrations/20260925-2000-crm-store-s4-trash.sql. This module is
 * the thin, staff-gated caller plus the two things SQL cannot do: removing bytes and streaming a zip.
 */

import type { User } from "@supabase/supabase-js"
import { Zip, ZipPassThrough } from "fflate"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isStoreStaffUser } from "@/lib/crm-store/access"
import { StoreAccessDeniedError, type PortalViewer } from "@/lib/crm-store/visibility"
import { createUploadIntent, type UploadIntent } from "@/lib/crm-store/writer"

type Actor = Pick<User, "id" | "app_metadata"> | null | undefined

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

function requireStaff(actor: Actor): string {
  if (!actor || !isStoreStaffUser(actor)) throw new StoreAccessDeniedError()
  return actor.id
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().rpc(fn, args)
  if (error) throw new Error(`[crm-store] ${fn} failed: ${error.message}`)
  return data as T
}

// ─────────────────────────────────────────────────────────────── trash / restore / remove from view

/** Staff: move one file to trash. Returns the batch id (restore it with restoreBatch). */
export async function trashFile(actor: Actor, fileId: string, reason?: string | null): Promise<string> {
  const id = requireStaff(actor)
  return rpc<string>("store_trash_file", { p_file_id: fileId, p_actor: id, p_reason: reason ?? null })
}

/** Staff: move a folder and everything under it to trash, as one batch. */
export async function trashFolder(actor: Actor, folderId: string, reason?: string | null): Promise<string> {
  const id = requireStaff(actor)
  return rpc<string>("store_trash_folder", { p_folder_id: folderId, p_actor: id, p_reason: reason ?? null })
}

export interface RestoreReport {
  restored: Array<{ kind: "file" | "folder"; id: string; name: string; renamed: boolean }>
  skipped: Array<{ kind: "file"; id: string; name: string; why: string }>
}

/**
 * Staff: restore a whole batch. Items go back to their original folder; if that folder is gone the
 * caller must name a live folder OF THE SAME CLIENT (the database refuses anything else).
 */
export async function restoreBatch(actor: Actor, batchId: string, targetFolderId?: string | null): Promise<RestoreReport> {
  const id = requireStaff(actor)
  return rpc<RestoreReport>("store_restore_batch", { p_batch_id: batchId, p_actor: id, p_target_folder: targetFolderId ?? null })
}

export interface TrashBatch {
  batch_id: string; owner_id: string; trashed_at: string; expires_at: string; trashed_by: string | null
  top_name: string | null; folders: number; files: number
}

/** Staff: what can still be restored (optionally for one client). */
export async function trashList(actor: Actor, ownerId?: string | null): Promise<TrashBatch[]> {
  requireStaff(actor)
  return (await rpc<TrashBatch[] | null>("store_trash_list", { p_owner_id: ownerId ?? null })) ?? []
}

/** Staff: "remove from view" — drop ONE record link (the file leaves that workspace). Never a trash. */
export async function removeFromView(
  actor: Actor, p: { fileId: string; linkKind: string; recordId: string; reason?: string | null },
): Promise<boolean> {
  const id = requireStaff(actor)
  return rpc<boolean>("store_remove_link", {
    p_file_id: p.fileId, p_link_kind: p.linkKind, p_record_id: p.recordId, p_actor: id, p_reason: p.reason ?? null,
  })
}

// ─────────────────────────────────────────────────────────────── the 90-day purge

export interface PurgeIO {
  listDue(now: Date): Promise<string[]>
  /** status: purged | already_purged | not_due (restored meanwhile) | held (legal hold, #61) */
  purgeFile(fileId: string, now: Date): Promise<{ status: string; hold?: string; objects?: Array<{ bucket: string; path: string }> }>
  removeObjects(bucket: string, paths: string[]): Promise<void>
  pendingObjects(): Promise<Array<{ bucket: string; path: string }>>
}

export interface PurgeTally {
  examined: number; purged: number; skipped: number; objectsRemoved: number; retried: number; errors: number
  /** what failed and why — the caller reports it (a silent purge failure is invisible otherwise) */
  failures: Array<{ fileId?: string; bucket?: string; message: string }>
}

export const purgeIO: PurgeIO = {
  async listDue(now) {
    const rows = await rpc<Array<{ file_id: string }> | null>("store_purge_due", { p_now: now.toISOString(), p_limit: 200 })
    return (rows ?? []).map((r) => r.file_id)
  },
  purgeFile: (fileId, now) => rpc("store_purge_file", { p_file_id: fileId, p_now: now.toISOString() }),
  async removeObjects(bucket, paths) {
    if (paths.length === 0) return
    const { error } = await db().storage.from(bucket).remove(paths)
    if (error) throw new Error(`[crm-store] could not remove ${paths.length} object(s) from ${bucket}: ${error.message}`)
  },
  async pendingObjects() {
    return (await rpc<Array<{ bucket: string; path: string }> | null>("store_purge_pending_objects", { p_limit: 200 })) ?? []
  },
}

function byBucket(objects: Array<{ bucket: string; path: string }>): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const o of objects) m.set(o.bucket, [...(m.get(o.bucket) ?? []), o.path])
  return m
}

/**
 * Purge everything whose trash window has ended. Order per file: the database turns it into a
 * tombstone FIRST (re-checking under a lock, so a restore that lands mid-sweep wins), THEN the bytes
 * are removed. A removal that fails leaves the version row pointing at the object, so the next run
 * finds it again (pendingObjects) — bytes are never stranded without a pointer.
 */
export async function purgeExpiredStore(now: Date, io: PurgeIO = purgeIO): Promise<PurgeTally> {
  const tally: PurgeTally = { examined: 0, purged: 0, skipped: 0, objectsRemoved: 0, retried: 0, errors: 0, failures: [] }
  const fail = (m: { fileId?: string; bucket?: string }, e: unknown) => {
    tally.errors++
    tally.failures.push({ ...m, message: e instanceof Error ? e.message : String(e) })
  }
  const due = await io.listDue(now)
  tally.examined = due.length
  for (const fileId of due) {
    try {
      const r = await io.purgeFile(fileId, now)
      if (r.status !== "purged") { tally.skipped++; continue }
      tally.purged++
      for (const [bucket, paths] of Array.from(byBucket(r.objects ?? []))) {
        try {
          await io.removeObjects(bucket, paths)
          tally.objectsRemoved += paths.length
        } catch (e) {
          fail({ fileId, bucket }, e)
        }
      }
    } catch (e) {
      fail({ fileId }, e)
    }
  }
  try {
    const pending = await io.pendingObjects()
    for (const [bucket, paths] of Array.from(byBucket(pending))) {
      try {
        await io.removeObjects(bucket, paths)
        tally.retried += paths.length
      } catch (e) {
        fail({ bucket }, e)
      }
    }
  } catch (e) {
    fail({}, e)
  }
  return tally
}

// ─────────────────────────────────────────────────────────────── folder upload

export interface FolderUploadFile { relativePath: string; mimeType?: string | null; size?: number | null }
export type FolderUploadResult =
  | { relativePath: string; status: "ready"; folderId: string; intent: UploadIntent }
  | { relativePath: string; status: "refused"; reason: string }

// eslint-disable-next-line no-control-regex -- the store's own name rule: no control characters
const CONTROL = /[\u0000-\u001f\u007f]/
export const FOLDER_UPLOAD_MAX_FILES = 500

/**
 * Split a browser folder-upload path ("Receipts/2025/scan 1.pdf" — always "/"-separated) into folder
 * segments + file name, applying the store's name rules up front so a file is refused on its own line
 * BEFORE its bytes are uploaded: no empty / "." / ".." parts, no control characters, ≤255 characters.
 * A backslash is a legal character in a file name, so it is kept, not treated as a separator.
 */
export function splitUploadPath(relativePath: string): { folders: string[]; fileName: string } {
  const raw = relativePath.split("/")
  const parts = raw.map((s) => s.trim())
  if (parts.every((p) => p.length === 0)) throw new Error("empty path")
  if (raw[0] === "") parts.shift()   // a leading "/" is harmless
  for (const p of parts) {
    if (p.length === 0) throw new Error("empty part in the path")
    if (p === "." || p === "..") throw new Error(`invalid path part "${p}"`)
    if (CONTROL.test(p)) throw new Error("the name contains control characters")
    if (p.length > 255) throw new Error("a name is longer than 255 characters")
  }
  return { folders: parts.slice(0, -1), fileName: parts[parts.length - 1] }
}

/**
 * Staff: prepare a whole-folder upload. For every file: create its sub-folders (once, idempotent) and a
 * one-time upload slot. One bad file never stops the others — each gets its own line in the report.
 * The browser then uploads each "ready" file into its slot and registers it (registerStagedUpload).
 */
export async function startFolderUpload(
  actor: Actor, p: { ownerId: string; parentFolderId: string; files: FolderUploadFile[] },
): Promise<FolderUploadResult[]> {
  const actorId = requireStaff(actor)
  const role = actor?.app_metadata?.role
  if (p.files.length > FOLDER_UPLOAD_MAX_FILES) {
    throw new Error(`store: upload at most ${FOLDER_UPLOAD_MAX_FILES} files at a time (got ${p.files.length}) — split the folder`)
  }
  const folderCache = new Map<string, string>()
  const out: FolderUploadResult[] = []
  for (const f of p.files) {
    try {
      const { folders, fileName } = splitUploadPath(f.relativePath)
      const key = folders.map((s) => s.toLowerCase()).join("/")
      let folderId = folderCache.get(key)
      if (!folderId) {
        // the database checks that the parent belongs to ownerId (a mismatch creates nothing)
        folderId = await rpc<string>("store_ensure_folder_path", { p_owner: p.ownerId, p_parent: p.parentFolderId, p_path: folders, p_actor: actorId })
        folderCache.set(key, folderId)
      }
      const intent = await createUploadIntent({
        ownerId: p.ownerId, folderId, fileName, mimeType: f.mimeType ?? null, actor: actorId, actorRole: role,
      })
      out.push({ relativePath: f.relativePath, status: "ready", folderId, intent })
    } catch (e) {
      out.push({ relativePath: f.relativePath, status: "refused", reason: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────── folder zip download

export interface ZipEntry { file_id: string; zip_path: string; bucket: string; object_path: string; size_bytes: number }

/** One zip may hold at most this much (the zip format this library writes stops at 4 GB, and the
 *  download must finish inside one server request). Bigger folders must be split. */
export const ZIP_MAX_BYTES = 2 * 1024 ** 3
export const ZIP_MAX_FILES = 2000

export class StoreZipTooLargeError extends Error {
  constructor(public bytes: number, public files: number) {
    super(`This folder is too large to download as one zip (${Math.round(bytes / 1024 ** 2)} MB, ${files} files) — download its sub-folders instead.`)
    this.name = "StoreZipTooLargeError"
  }
}

/** Make every path safe to unpack on Windows, macOS and Linux, and unique inside the zip. */
export function safeZipPaths(entries: ZipEntry[]): ZipEntry[] {
  const clean = (seg: string) => {
    let s = seg.replace(/[<>:"|?*\\]/g, "_").replace(/[. ]+$/, "")
    if (s === "" || s === "." || s === "..") s = "_"
    return s
  }
  const used = new Set<string>()
  const out: ZipEntry[] = []
  const folderNames = new Set<string>()
  for (const e of entries) {
    const segs = e.zip_path.split("/").map(clean)
    for (let i = 1; i < segs.length; i++) folderNames.add(segs.slice(0, i).join("/").toLowerCase())
  }
  for (const e of entries) {
    const segs = e.zip_path.split("/").map(clean)
    let path = segs.join("/")
    const dot = path.lastIndexOf(".")
    const base = dot > path.lastIndexOf("/") ? path.slice(0, dot) : path
    const ext = dot > path.lastIndexOf("/") ? path.slice(dot) : ""
    for (let n = 2; used.has(path.toLowerCase()) || folderNames.has(path.toLowerCase()); n++) path = `${base} (${n})${ext}`
    used.add(path.toLowerCase())
    out.push({ ...e, zip_path: path })
  }
  return out
}

/** Refuse (before streaming anything) a zip that is too large to finish in one request. */
export function assertZipFits(entries: ZipEntry[]): void {
  const bytes = entries.reduce((n, e) => n + Number(e.size_bytes ?? 0), 0)
  if (bytes > ZIP_MAX_BYTES || entries.length > ZIP_MAX_FILES) throw new StoreZipTooLargeError(bytes, entries.length)
}

/**
 * The files of a folder tree that this requester may download, each already through the privacy check
 * (a portal viewer never receives another member's personal file). Staff get every live file.
 */
export async function folderZipListing(
  folderId: string, who: { viewer: PortalViewer } | { staff: Actor },
): Promise<ZipEntry[]> {
  if ("staff" in who) {
    requireStaff(who.staff)
    return (await rpc<ZipEntry[] | null>("store_folder_zip_listing", {
      p_folder_id: folderId, p_contact_id: null, p_teammate_id: null, p_staff: true,
    })) ?? []
  }
  const v = who.viewer
  const contact = "contactId" in v && v.contactId ? v.contactId : null
  const teammate = "teammateId" in v && v.teammateId ? v.teammateId : null
  if ((contact === null) === (teammate === null)) throw new Error("store: a portal viewer is exactly one contact or one teammate")
  return (await rpc<ZipEntry[] | null>("store_folder_zip_listing", {
    p_folder_id: folderId, p_contact_id: contact, p_teammate_id: teammate, p_staff: false,
  })) ?? []
}

export type ObjectOpener = (bucket: string, path: string) => Promise<ReadableStream<Uint8Array>>

export const openStoredObject: ObjectOpener = async (bucket, path) => {
  const { data, error } = await db().storage.from(bucket).createSignedUrl(path, 600)
  if (error || !data?.signedUrl) throw new Error(`store: cannot read ${path} (${error?.message ?? "no url"})`)
  const res = await fetch(data.signedUrl)
  if (!res.ok || !res.body) throw new Error(`store: cannot read ${path} (HTTP ${res.status})`)
  return keepAliveBody(res)
}

/**
 * A fetch Response's body that keeps the Response itself alive while the body is used: Node's fetch cancels the
 * body of a Response that is garbage-collected, which (with files opened ahead for a zip) came back as a
 * silently EMPTY file. Every store reader that hands a body on uses this.
 */
export function keepAliveBody(res: Response): ReadableStream<Uint8Array> {
  if (!res.body) throw new Error("store: the file came back with no content")
  const reader = res.body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      const { done, value } = await reader.read()
      if (done) { c.close(); void res.status } else c.enqueue(value)
    },
    cancel(reason) { return reader.cancel(reason) },
  })
}

/**
 * Stream a zip of the given entries, one file at a time (the next few are opened ahead), pulled at the DOWNLOADER's pace (the next
 * piece is read only when the previous one has been taken), never holding a file in memory. Stored,
 * not re-compressed (documents are mostly PDFs/images). Refuses up front if too large; paths are made
 * safe; each file's byte count is checked against what was saved. A file that cannot be opened becomes
 * a small "…could not be included.txt" note so the zip still completes and says so.
 */
export function streamZip(entries: ZipEntry[], open: ObjectOpener = openStoredObject): ReadableStream<Uint8Array> {
  assertZipFits(entries)
  const list = safeZipPaths(entries)
  const out: Uint8Array[] = []
  let finished = false
  let failed: unknown = null
  const zip = new Zip((err, chunk, final) => {
    if (err) { failed = err; return }
    out.push(chunk)
    if (final) finished = true
  })
  let idx = 0
  // look-ahead: the next few files are OPENED while the current one streams (each open is two network trips —
  // one after another, 2,000 files would outlast the server's time limit). Files still go into the zip one at a
  // time, in order; an opened file is not read until its turn.
  const AHEAD = 8
  const opening = new Map<number, Promise<ReadableStream<Uint8Array>>>()
  let stopped = false // cancelled by the downloader, or failed: nothing more is opened
  const openAhead = () => {
    if (stopped) return
    for (let k = idx; k < Math.min(list.length, idx + AHEAD); k++) {
      if (!opening.has(k)) {
        const pr = open(list[k].bucket, list[k].object_path)
        pr.catch(() => { /* handled when its turn comes */ })
        opening.set(k, pr)
      }
    }
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let entry: ZipPassThrough | null = null
  let seen = 0
  let current: ZipEntry | null = null

  async function step(): Promise<void> {
    if (reader && entry && current) {
      const { done, value } = await reader.read()
      if (!done) { seen += value.byteLength; entry.push(value); return }
      if (seen !== Number(current.size_bytes)) throw new Error(`store: ${current.zip_path} came back ${seen} bytes, saved ${current.size_bytes}`)
      entry.push(new Uint8Array(0), true)
      reader = null; entry = null; current = null
      return
    }
    if (idx >= list.length) { zip.end(); return }
    openAhead()
    const at = idx
    const e = list[idx++]
    const pending = opening.get(at) ?? open(e.bucket, e.object_path)
    opening.delete(at)
    const note = () => {
      const n = new ZipPassThrough(`${e.zip_path} - could not be included.txt`)
      zip.add(n)
      n.push(new TextEncoder().encode(`This file could not be read when the zip was made: ${e.zip_path}\n`), true)
    }
    let r: ReadableStreamDefaultReader<Uint8Array>
    try { r = (await pending).getReader() } catch { note(); return }
    if (stopped) { r.cancel().catch(() => {}); return } // cancelled while it was opening
    // its first piece is read BEFORE it goes into the zip: a file that fails (or comes back empty) right away
    // becomes a note and the zip completes; a failure half-way still fails loudly (the size check)
    let first: ReadableStreamReadResult<Uint8Array>
    try { first = await r.read() } catch { r.cancel().catch(() => {}); note(); return }
    if (first.done && Number(e.size_bytes) !== 0) { note(); return }
    entry = new ZipPassThrough(e.zip_path)
    zip.add(entry)
    current = e
    seen = 0
    if (first.done) { entry.push(new Uint8Array(0), true); entry = null; current = null; return }
    reader = r
    seen = first.value.byteLength
    entry.push(first.value)
  }
  const letGo = () => {
    stopped = true
    reader?.cancel().catch(() => {})
    // files opened ahead and never read: let them go
    for (const pr of Array.from(opening.values())) pr.then((st) => st.cancel()).catch(() => {})
    opening.clear()
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (out.length === 0 && !finished) {
          await step()
          if (failed) throw failed
        }
        if (out.length > 0) controller.enqueue(out.shift()!)
        if (finished && out.length === 0) controller.close()
      } catch (err) {
        letGo()
        controller.error(err)
      }
    },
    cancel() { letGo() },
  })
}
