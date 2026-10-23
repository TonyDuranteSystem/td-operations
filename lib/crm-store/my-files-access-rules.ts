/**
 * My files ACCESS — the PURE rules (Antonio, 2026-10-23: "full write access to my files", option 4). No database, no network. The server half is `my-files-access.ts`.
 * The content comes from an AI session that may have read hostile text, so the safeguards stay even with full access: an env switch (default OFF), the owner only, everything
 * scoped to the owner's own private area, nothing inside "Shared with staff" changed, no permanent delete (trash only, 90 days), hourly limits, and every action audited.
 */
export const ACCESS_SWITCH = "MY_FILES_ACCESS_ENABLED"
export const accessEnabled = (): boolean => process.env[ACCESS_SWITCH] === "1"

export const ACCESS_LIMITS = {
  /** reads and lists in the last hour */
  readsPerHour: 300,
  /** writes, folders, renames, moves, trashes, restores in the last hour */
  changesPerHour: 80,
  /** a text file read back is cut here (characters) */
  maxReadChars: 200_000,
  /** a file bigger than this is not even downloaded for a read (bytes) */
  maxReadBytes: 25 * 1024 * 1024,
  /** a binary file read back as base64 is refused above this (bytes): it has to fit in a tool answer */
  maxReadBase64Bytes: 3 * 1024 * 1024,
  /** a folder listing shows at most this many entries */
  maxListEntries: 500,
  /** a folder with more live files than this is not trashed in one go (trash it from the Storage page) */
  maxTrashFolderFiles: 200,
  /** bytes written in the last hour (new files + new versions) */
  writeBytesPerHour: 60 * 1024 * 1024,
} as const

/** Every tool call writes one action_log row; this is the tool-name prefix and the two action kinds the limits count. */
export const ACCESS_TOOL_PREFIX = "my_files_"
export type AccessKind = "read" | "change"

import { validateStorageName } from "@/lib/crm-storage/name-guard"
import { cleanNewFileName } from "./names"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v)

/** The refusal text when the hour's budget is used up, else null. */
export function accessRateRefusal(kind: AccessKind, usedLastHour: number): string | null {
  const cap = kind === "read" ? ACCESS_LIMITS.readsPerHour : ACCESS_LIMITS.changesPerHour
  return usedLastHour >= cap ? `Too many ${kind === "read" ? "reads" : "changes"} in the last hour (${cap} allowed). Wait a while, or do the rest from the Storage page.` : null
}

const TEXTUAL_EXT = new Set(["md", "txt", "csv", "json", "html", "htm", "xml", "yaml", "yml", "tsv", "log"])
/** Can this file be handed back as plain text? (by its extension or MIME; everything else needs as_base64) */
export function isTextual(name: string, mime: string | null): boolean {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : ""
  return TEXTUAL_EXT.has(ext) || (mime !== null && /^text\//.test(mime)) || mime === "application/json"
}

/** Cut text to the read limit and say so. */
export function clipText(s: string): { text: string; cut: boolean } {
  return s.length > ACCESS_LIMITS.maxReadChars ? { text: s.slice(0, ACCESS_LIMITS.maxReadChars), cut: true } : { text: s, cut: false }
}

export type IfExists = "refuse" | "new_version" | "copy"
export const IF_EXISTS_VALUES: readonly IfExists[] = ["refuse", "new_version", "copy"]
export function parseIfExists(v: unknown): IfExists | null {
  if (v === undefined || v === null) return "refuse"
  return IF_EXISTS_VALUES.includes(v as IfExists) ? (v as IfExists) : null
}

/** A folder path below the My files top, as segments: 1 to 6 names, none empty, none a dot-path. */
export function parseFolderPath(input: unknown): { ok: true; segments: string[] } | { ok: false; error: string } {
  if (typeof input !== "string" || !input.trim()) return { ok: false, error: "path must be text like \"TD Marketing/Plans\"." }
  const segs = input.split("/").map(s => s.trim()).filter(Boolean)
  if (segs.length === 0 || segs.length > 6) return { ok: false, error: "path must have 1 to 6 folder names." }
  if (segs.some(s => s === "." || s === ".." || s.length > 120 || /[\\\u0000-\u001f\u007f]/.test(s) || SPOOF_CHARS.test(s))) return { ok: false, error: "A folder name in the path is not allowed." }
  return { ok: true, segments: segs }
}

/** Like parseFolderPath, but nothing (or "/") means the My files top. */
export function parseOptionalPath(input: unknown): { ok: true; segments: string[] } | { ok: false; error: string } {
  if (input === undefined || input === null || (typeof input === "string" && (input.trim() === "" || input.trim() === "/"))) return { ok: true, segments: [] }
  return parseFolderPath(input)
}

// look-alike characters: right-to-left overrides, zero-width and other invisible formatting (same list as the drop's)
// eslint-disable-next-line no-misleading-character-class
const SPOOF_CHARS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/

/** A new name for an existing file: the extension never changes (the store's own rule), and the storage name rules + no look-alike characters apply. */
export function checkRenamedFile(input: unknown, currentName: string): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof input !== "string" || !input.trim()) return { ok: false, error: "new_name is required." }
  let name: string
  try { name = cleanNewFileName(input, currentName) } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "That name is not accepted." } }
  const g = validateStorageName(name)
  if (g.error) return { ok: false, error: `File name not accepted: ${g.error}.` }
  if (SPOOF_CHARS.test(g.name)) return { ok: false, error: "File name not accepted: it contains hidden or direction-changing characters." }
  if (g.name.startsWith(".") || /[. ]$/.test(g.name)) return { ok: false, error: "File name not accepted: it cannot start with a dot or end with a dot or a space." }
  return { ok: true, name: g.name }
}
