/**
 * My files DROP — the PURE rules (dev job 1ed4fb18). No database, no network: every decision about what a Claude session
 * may drop into Antonio's private "My files" › "From Claude" that can be made from the request alone is made here, so it
 * is unit-tested without a stack. The server half is `my-files-drop.ts`.
 *
 * Posture: the content comes from an AI session that may have read hostile text (an email, a web page), so the allow-list is
 * short, the kinds that carry macros / scripts / remote content are not on it, and the OOXML containers are inspected
 * (central directory only — nothing is ever unpacked).
 */
import { createHash } from "crypto"
import { validateStorageName } from "@/lib/crm-storage/name-guard"

/** What the MCP transport can really carry (the platform limit on a request body is far below the old 25 MB idea). */
export const DROP_MAX_BYTES = 3 * 1024 * 1024
export const DROP_FOLDER_NAME = "From Claude"
export const DROP_KEY_PREFIX = "my-files-drop:"
export const DROP_MAX_SUBFOLDER_SEGMENTS = 3
/** The setting that remembers WHICH folder is the drop folder (by id — Antonio may rename or move it). */
export const DROP_FOLDER_SETTING = "my_files_drop_folder_id"

export const DROP_LIMITS = { perHour: 30, perDay: 200, bytesPerDay: 200 * 1024 * 1024 } as const

/** extension → MIME. The MIME is ALWAYS derived from the extension; the caller never supplies one. */
export const DROP_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
}
const OOXML = new Set(["docx", "xlsx", "pptx"])
const TEXT = new Set(["md", "txt", "csv", "json"])

export const ALLOWED_EXTENSIONS_TEXT = Object.keys(DROP_TYPES).join(", ")

// right-to-left / bidi overrides and isolates, zero-width and other invisible formatting: a name that LOOKS like another one
// eslint-disable-next-line no-misleading-character-class
const SPOOF_CHARS = /[​-‏‪-‮⁠-⁩﻿]/

export type Checked<T> = ({ ok: true } & T) | { ok: false; error: string }

/** A file name: the storage name rules + no look-alike characters, no leading dot, no trailing dot/space, and an allowed extension. */
export function checkDropName(input: unknown): Checked<{ name: string; ext: string; mime: string }> {
  const g = validateStorageName(input)
  if (g.error) return { ok: false, error: `File name not accepted: ${g.error}.` }
  const name = g.name
  if (SPOOF_CHARS.test(name)) return { ok: false, error: "File name not accepted: it contains hidden or direction-changing characters." }
  if (name.startsWith(".")) return { ok: false, error: "File name not accepted: it cannot start with a dot." }
  if (/[. ]$/.test(name)) return { ok: false, error: "File name not accepted: it cannot end with a dot or a space." }
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name)
  const ext = m ? m[1].toLowerCase() : ""
  const mime = DROP_TYPES[ext]
  if (!mime) return { ok: false, error: `File type ".${ext || "(none)"}" is not accepted. Allowed: ${ALLOWED_EXTENSIONS_TEXT}.` }
  return { ok: true, name, ext, mime }
}

/** An optional relative sub-folder below "From Claude": up to 3 names, no slash tricks inside a name. */
export function checkDropSubfolder(input: unknown): Checked<{ segments: string[] }> {
  if (input === undefined || input === null || input === "") return { ok: true, segments: [] }
  if (typeof input !== "string") return { ok: false, error: "subfolder must be text like \"TD Marketing\" or \"TD Marketing/Plans\"." }
  if (input.includes("\\")) return { ok: false, error: "subfolder cannot contain a backslash." }
  const parts = input.split("/").map((s) => s.trim()).filter((s) => s.length > 0)
  if (parts.length > DROP_MAX_SUBFOLDER_SEGMENTS) return { ok: false, error: `subfolder can be at most ${DROP_MAX_SUBFOLDER_SEGMENTS} levels deep.` }
  const segments: string[] = []
  for (const p of parts) {
    const g = validateStorageName(p)
    if (g.error) return { ok: false, error: `subfolder "${p.slice(0, 40)}" not accepted: ${g.error}.` }
    if (SPOOF_CHARS.test(g.name) || g.name.startsWith(".") || /[. ]$/.test(g.name)) return { ok: false, error: `subfolder "${p.slice(0, 40)}" not accepted (dot, space or hidden characters).` }
    segments.push(g.name)
  }
  return { ok: true, segments }
}

/** Exactly one of text / content_base64. Text is measured in UTF-8 bytes; base64 is checked BEFORE it is decoded. */
export function decodeDropContent(text: unknown, base64: unknown): Checked<{ bytes: Buffer }> {
  const hasText = text !== undefined && text !== null
  const hasB64 = base64 !== undefined && base64 !== null
  if (hasText === hasB64) return { ok: false, error: "Send exactly one of: text, or content_base64." }
  if (hasText) {
    if (typeof text !== "string") return { ok: false, error: "text must be a string." }
    if (Buffer.byteLength(text, "utf8") > DROP_MAX_BYTES) return { ok: false, error: tooBig(Buffer.byteLength(text, "utf8")) }
    const bytes = Buffer.from(text, "utf8")
    if (bytes.length === 0) return { ok: false, error: "The file is empty." }
    return { ok: true, bytes }
  }
  if (typeof base64 !== "string") return { ok: false, error: "content_base64 must be a string." }
  const clean = base64.replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "")
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) return { ok: false, error: "content_base64 is not valid standard base64." }
  const approx = Math.floor((clean.length * 3) / 4)
  if (approx > DROP_MAX_BYTES + 3) return { ok: false, error: tooBig(approx) }
  const bytes = Buffer.from(clean, "base64")
  if (bytes.length === 0) return { ok: false, error: "The file is empty." }
  if (bytes.length > DROP_MAX_BYTES) return { ok: false, error: tooBig(bytes.length) }
  return { ok: true, bytes }
}
const tooBig = (n: number) => `The file is ${(n / 1048576).toFixed(1)} MB; the limit is ${DROP_MAX_BYTES / 1048576} MB. Larger files must be added to Storage by hand.`

const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  pdf: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-",
  png: (b) => b.length > 8 && b[0] === 0x89 && b.subarray(1, 4).toString("latin1") === "PNG",
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => b.subarray(0, 4).toString("latin1") === "GIF8",
  webp: (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
}

/** Does the content look like what its extension says? (A real control is the MIME-from-extension rule; this stops honest mistakes.) */
export function checkDropContent(ext: string, bytes: Buffer): Checked<object> {
  if (OOXML.has(ext)) {
    const z = inspectOoxml(bytes)
    return z ? { ok: false, error: z } : { ok: true }
  }
  if (TEXT.has(ext)) {
    if (bytes.includes(0)) return { ok: false, error: `This does not look like a ${ext} text file (it contains binary data).` }
    let s: string
    try { s = new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch { return { ok: false, error: `A .${ext} file must be UTF-8 text.` } }
    if (ext === "csv") { const bad = csvFormulaCell(s); if (bad) return { ok: false, error: bad } }
    return { ok: true }
  }
  const sig = SIGNATURES[ext]
  if (sig && !sig(bytes)) return { ok: false, error: `The content does not look like a real .${ext} file.` }
  return { ok: true }
}

/** A CSV cell that a spreadsheet would run as a formula: it starts with = @ + or - and is not a plain number (a negative number is fine). */
export function csvFormulaCell(csv: string): string | null {
  for (const line of csv.split(/\r\n|\r|\n/)) {
    for (const cellRaw of line.split(/[,;\t]/)) {
      const cell = cellRaw.trim().replace(/^"+/, "")
      if (/^[=@+-]/.test(cell) && !/^[+-]?\d+([.,]\d+)?%?$/.test(cell.replace(/"+$/, ""))) {
        return "A CSV cell starts with = @ + or - and is not a plain number — a spreadsheet would run it as a formula. Put a space in front of it, or send it as text."
      }
    }
  }
  return null
}

/** docx / xlsx / pptx are zip files: read the central directory only. null = fine, else the reason it is refused. */
export function inspectOoxml(b: Buffer): string | null {
  const bad = "This Office file is not accepted"
  if (b.length < 22 || b.readUInt32LE(0) !== 0x04034b50) return `${bad}: it is not a real Office document.`
  let eocd = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return `${bad}: the zip directory is damaged.`
  const commentLen = b.readUInt16LE(eocd + 20)
  if (eocd + 22 + commentLen !== b.length) return `${bad}: the zip directory is damaged.`
  const total = b.readUInt16LE(eocd + 10)
  const cdSize = b.readUInt32LE(eocd + 12)
  const cdOff = b.readUInt32LE(eocd + 16)
  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) return `${bad}: zip64 files are not accepted.`
  if (total > 1000) return `${bad}: it holds more than 1000 parts.`
  if (cdOff + cdSize > b.length) return `${bad}: the zip directory is damaged.`
  let p = cdOff
  let unpacked = 0
  let packed = 0
  let hasContentTypes = false
  for (let i = 0; i < total; i++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) return `${bad}: the zip directory is damaged.`
    const flags = b.readUInt16LE(p + 8)
    const csize = b.readUInt32LE(p + 20)
    const usize = b.readUInt32LE(p + 24)
    const nlen = b.readUInt16LE(p + 28)
    const elen = b.readUInt16LE(p + 30)
    const clen = b.readUInt16LE(p + 32)
    if (p + 46 + nlen > b.length) return `${bad}: the zip directory is damaged.`
    const name = b.subarray(p + 46, p + 46 + nlen).toString("utf8").toLowerCase()
    if (flags & 1) return `${bad}: it is encrypted.`
    if (name === "[content_types].xml") hasContentTypes = true
    if (name.endsWith("vbaproject.bin") || name.includes("macrosheets/")) return `${bad}: it contains macros.`
    if (name.includes("externallinks/") || name.includes("/embeddings/") || name.startsWith("embeddings/") || name.includes("/activex/") || name.startsWith("activex/")) return `${bad}: it contains linked or embedded content (a chart with its own data sheet counts) — send it as a PDF instead.`
    if (name.endsWith(".zip") || name.endsWith(".docx") || name.endsWith(".xlsx") || name.endsWith(".pptx")) return `${bad}: it contains another archive.`
    unpacked += usize
    packed += csize
    p += 46 + nlen + elen + clen
  }
  if (p !== cdOff + cdSize) return `${bad}: the zip directory is damaged.`
  if (!hasContentTypes) return `${bad}: it is not a real Office document.`
  if (unpacked > 150 * 1024 * 1024) return `${bad}: it would unpack to more than 150 MB.`
  if ((packed === 0 && unpacked > 0) || (packed > 0 && unpacked / packed > 100)) return `${bad}: its compression ratio is suspicious.`
  return null
}

const KEY_RE = /^[A-Za-z0-9._:\-]{1,100}$/

/** The storage key. Optional from the caller; the default is derived from the sub-folder, name and content so a retry is a no-op. */
export function dropCallerKey(userKey: unknown, segments: string[], name: string, sha256: string): Checked<{ key: string; derived: boolean }> {
  if (userKey === undefined || userKey === null || userKey === "") {
    const h = createHash("sha256").update([...segments, name].join("/")).update("\0").update(sha256).digest("hex").slice(0, 32)
    return { ok: true, key: `${DROP_KEY_PREFIX}auto:${h}`, derived: true }
  }
  if (typeof userKey !== "string" || !KEY_RE.test(userKey)) return { ok: false, error: "caller_key must be 1-100 characters from A-Z a-z 0-9 . _ : -" }
  if (userKey.startsWith(DROP_KEY_PREFIX) || userKey.startsWith("auto:")) return { ok: false, error: "caller_key cannot start with \"auto:\" or the internal prefix." }
  return { ok: true, key: `${DROP_KEY_PREFIX}${userKey}`, derived: false }
}

export interface RecentDrops { lastHour: number; lastDay: number; bytesLastDay: number }
/** The rate limit decision. Null = allowed, else the plain reason (a fixed string — it says which limit, nothing else). */
export function dropRateRefusal(r: RecentDrops, addBytes: number): string | null {
  if (r.lastHour >= DROP_LIMITS.perHour) return `Too many files saved in the last hour (limit ${DROP_LIMITS.perHour}). Try again later.`
  if (r.lastDay >= DROP_LIMITS.perDay) return `Too many files saved in the last 24 hours (limit ${DROP_LIMITS.perDay}). Try again tomorrow.`
  if (r.bytesLastDay + addBytes > DROP_LIMITS.bytesPerDay) return `Too much data saved in the last 24 hours (limit ${DROP_LIMITS.bytesPerDay / 1048576} MB). Try again tomorrow.`
  return null
}

export const sha256Of = (b: Buffer): string => createHash("sha256").update(b).digest("hex")
