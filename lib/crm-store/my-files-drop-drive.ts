/**
 * My files DROP — the "copy from Antonio's Google Drive" half (dev job 465a11fc). Reads ONE file from his personal Drive, READ-ONLY, and only
 * if it sits inside the one folder tree named by the setting MY_FILES_DROP_DRIVE_ROOT_FOLDER_ID (production: "CRM Projects"). The Drive calls
 * themselves live in lib/google-drive.ts (`readOwnerDropMeta`, `downloadOwnerDropBytes`: owner identity, drive.readonly token, files.get only);
 * this module decides what may be read and checks that what arrived is what was promised. The reader is passed in, so every rule here is
 * unit-tested with a fake Drive.
 *
 * The folder check is THE control: the file id comes from an AI session that may have read hostile text. It is made once before the download and
 * again after it (a file moved out meanwhile is refused). Anything unexpected — an error, a loop, a shared drive, two parents — refuses.
 */
import { DROP_DRIVE_MAX_BYTES, driveFileRefusal, md5Of } from "./my-files-drop-rules"

export interface DriveMetaLike {
  id: string; name: string; mimeType: string; size: number | null; md5: string | null; ownedByMe: boolean; trashed: boolean
  parents: string[]; driveId: string | null; version: string | null; modifiedTime: string | null
}
export interface DriveReader {
  meta(id: string): Promise<DriveMetaLike>
  /** Streams with a hard cap; throws an error whose `code` is "too_big" when the cap is passed. */
  bytes(id: string, maxBytes: number): Promise<Buffer>
}

export const DRIVE_WALK_MAX_DEPTH = 25
export const DRIVE_WALK_MAX_LOOKUPS = 60
const FOLDER = "application/vnd.google-apps.folder"

const NOT_THERE = "That file was not found inside the Drive folder this tool is allowed to copy from."
const UNREADABLE = "Google Drive could not be read right now. Nothing was copied; try again in a minute."
const CHANGED = "The file changed in Drive while it was being copied. Nothing was saved; try again."

export type DriveStep<T> = ({ ok: true } & T) | { ok: false; error: string }

/** Does this file sit (through single-parent, live, non-shared-drive folders) under the root folder? Bounded; any doubt = no. */
export async function walkToRoot(reader: DriveReader, file: DriveMetaLike, rootId: string): Promise<"in" | "out" | "error"> {
  try {
    if (file.id === rootId) return "out" // the root itself is a folder, never a file to copy
    let cur: DriveMetaLike = file
    const seen = new Set<string>([file.id])
    let lookups = 0
    for (let depth = 0; depth < DRIVE_WALK_MAX_DEPTH; depth++) {
      if (cur.driveId) return "out" // a shared-drive item is never in his personal tree
      if (cur.parents.length !== 1) return "out" // no parent (shared-with-me / root) or more than one path: not provably inside
      const parent = cur.parents[0]
      if (parent === rootId) return "in"
      if (seen.has(parent)) return "out" // loop
      seen.add(parent)
      if (++lookups > DRIVE_WALK_MAX_LOOKUPS) return "out"
      let p: DriveMetaLike
      try { p = await reader.meta(parent) } catch (e) { return codeOf(e) === "unavailable" ? "out" : "error" } // an ancestor he cannot see = not provably inside
      if (p.id !== parent || p.mimeType !== FOLDER || p.trashed) return "out"
      cur = p
    }
    return "out"
  } catch { return "error" }
}

export interface DriveCandidate { meta: DriveMetaLike }

/** Stage 1 — before anything is downloaded: read the metadata, prove the folder, then apply the plain refusals. */
export async function inspectDriveFile(reader: DriveReader, fileId: string, rootId: string): Promise<DriveStep<DriveCandidate>> {
  let meta: DriveMetaLike
  try { meta = await reader.meta(fileId) } catch (e) { return { ok: false, error: codeOf(e) === "unavailable" ? NOT_THERE : UNREADABLE } }
  if (meta.id !== fileId) return { ok: false, error: UNREADABLE }
  const w = await walkToRoot(reader, meta, rootId)
  if (w === "error") return { ok: false, error: UNREADABLE }
  if (w === "out") return { ok: false, error: NOT_THERE } // same sentence as "no such file": nothing about an outside file is revealed
  const why = driveFileRefusal(meta)
  return why ? { ok: false, error: why } : { ok: true, meta }
}

/** Stage 2 — download with the cap, then prove the bytes are the file that was inspected (size, checksum) and that it did not move or change. */
export async function fetchDriveBytes(reader: DriveReader, before: DriveMetaLike, rootId: string): Promise<DriveStep<{ bytes: Buffer }>> {
  let bytes: Buffer
  try { bytes = await reader.bytes(before.id, DROP_DRIVE_MAX_BYTES) } catch (e) {
    if (codeOf(e) === "too_big") return { ok: false, error: `The file is larger than ${DROP_DRIVE_MAX_BYTES / 1048576} MB. Larger files must be added to Storage by hand.` }
    return { ok: false, error: codeOf(e) === "unavailable" ? NOT_THERE : UNREADABLE }
  }
  if (bytes.length === 0 || bytes.length !== before.size) return { ok: false, error: CHANGED }
  if (md5Of(bytes) !== before.md5) return { ok: false, error: CHANGED }
  let after: DriveMetaLike
  try { after = await reader.meta(before.id) } catch { return { ok: false, error: UNREADABLE } }
  if (after.trashed || after.md5 !== before.md5 || after.size !== before.size || after.name !== before.name
    || after.parents.length !== before.parents.length || after.parents.some((p, i) => p !== before.parents[i])) return { ok: false, error: CHANGED }
  const w = await walkToRoot(reader, after, rootId)
  if (w === "error") return { ok: false, error: UNREADABLE }
  if (w === "out") return { ok: false, error: NOT_THERE }
  return { ok: true, bytes }
}

function codeOf(e: unknown): string { return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "" }

/** The real Drive (owner identity, read-only) behind the DriveReader interface. Imported lazily so unit tests never load the Google client. */
export async function realDriveReader(): Promise<DriveReader> {
  const g = await import("@/lib/google-drive")
  return { meta: (id) => g.readOwnerDropMeta(id), bytes: (id, max) => g.downloadOwnerDropBytes(id, max) }
}

/** The configured folder, or null = the Drive copy is switched off (never defaults to any folder). */
export function driveRootFolder(): string | null {
  const v = (process.env.MY_FILES_DROP_DRIVE_ROOT_FOLDER_ID ?? "").trim()
  return /^[A-Za-z0-9_-]{10,100}$/.test(v) ? v : null
}
