/**
 * Saving a NEW file from a Mac into the storage (dev job 1992a087, phase P3 step A). PURE rules — no database, no network.
 * Step A only saves into the firm's own areas (Business, a staff member's My files); client and person storages come in a later step.
 */
import { isInternalOwnerKind } from "@/lib/crm-store/plain-drop"

/** Step B slice 1: client storages a Mac may save into, and the folder kinds inside them (a team-made folder, or Correspondence). Banking, Tax, Tax year, the company's own papers, ITIN, personal folders and companies being formed come later. */
export const CLIENT_SAVE_OWNER_KINDS: ReadonlySet<string> = new Set(["company", "person"])
export const CLIENT_SAVE_FOLDER_KINDS: ReadonlySet<string> = new Set(["custom", "correspondence"])
export const isClientSaveOwner = (kind: string | null | undefined): boolean => !!kind && CLIENT_SAVE_OWNER_KINDS.has(kind)

/** Staged and registered inline up to this size (the CRM's own limit for the inline path); bigger files are refused for now. */
export const MAX_SAVE_BYTES = 150 * 1024 * 1024
export const MAX_NAME_BYTES = 255

/** Names a Mac never saves: system junk and other apps' temporary names. KNOWN patterns only (mirrors NameMapper.isJunk in the Mac app) — a real file such as "Q3.sb-final.pdf" is kept. */
export function isJunkName(name: string): boolean {
  const n = name.toLowerCase()
  if (n === ".ds_store" || n === "thumbs.db" || n === "desktop.ini" || n === "icon\r") return true
  if (n.startsWith("._") || n.startsWith("~$") || n.startsWith(".~lock.") || n.startsWith("(a document being saved by")) return true
  for (const ext of [".tmp", ".crdownload", ".part", ".partial", ".download", ".opdownload"]) if (n.endsWith(ext)) return true
  if (/\.sb-[0-9a-f]{8}-[0-9a-z]{6}$/.test(n)) return true     // Apple's atomic-save temp name
  return false
}

/** The name as the CRM will store it: NFC, no control characters, trimmed. null = not a usable file name. */
export function cleanFileName(name: unknown): string | null {
  if (typeof name !== "string") return null
  const t = name.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").trim()
  if (!t || t === "." || t === "..") return null
  if (new TextEncoder().encode(t).length > MAX_NAME_BYTES) return null
  return t
}

/** The Mac's own stable id for one new file (one per file it saves; makes a retry safe). */
const ITEM_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isItemKey = (k: unknown): k is string => typeof k === "string" && ITEM_KEY.test(k)

/** The key that makes saving idempotent: one Mac + one of its files. Never built from the folder or the name. */
export const saveCallerKey = (deviceId: string, itemKey: string): string => `storage-app:${deviceId}:${itemKey.toLowerCase()}`

export type SaveRefusal =
  | { ok: true }
  | { ok: false; code: "not_found" | "not_allowed" | "too_big" | "bad_name" | "ignored" | "exists"; message: string }

/** Where step A allows a save: inside a folder (never a storage's top folder, never "2. Contacts", never "Shared with staff") of Business or My files. */
export function checkDestination(p: { ownerKind: string | null | undefined; folderKind: string | null | undefined; inStaffShare: boolean; folderTrashed: boolean }): SaveRefusal {
  if (p.folderTrashed) return { ok: false, code: "not_found", message: "That folder is in the trash." }
  if (/(^|_)root$/.test(p.folderKind ?? "")) return { ok: false, code: "not_allowed", message: "Open one of the folders first — files go inside a folder, not at the top." }
  if (p.folderKind === "contacts") return { ok: false, code: "not_allowed", message: "People's documents are added in the CRM, not from the Mac." }
  if (p.inStaffShare) return { ok: false, code: "not_allowed", message: "\"Shared with staff\" is managed in the CRM." }
  if (isInternalOwnerKind(p.ownerKind)) return { ok: true }
  if (isClientSaveOwner(p.ownerKind)) {
    if (CLIENT_SAVE_FOLDER_KINDS.has(p.folderKind ?? "")) return { ok: true }
    return { ok: false, code: "not_allowed", message: "Saving into this folder from the Mac is not available yet — for now only Correspondence and the folders your team added." }
  }
  return { ok: false, code: "not_allowed", message: "Saving here from the Mac is not available yet." }
}

export function checkNewFile(p: { name: unknown; size: unknown }): SaveRefusal & { cleanName?: string } {
  const name = cleanFileName(p.name)
  if (!name) return { ok: false, code: "bad_name", message: "This file name cannot be used." }
  if (isJunkName(name)) return { ok: false, code: "ignored", message: "This is a system or temporary file — it is not saved." }
  if (typeof p.size !== "number" || !Number.isFinite(p.size) || p.size < 0) return { ok: false, code: "bad_name", message: "The file size is missing." }
  if (p.size > MAX_SAVE_BYTES) return { ok: false, code: "too_big", message: "This file is too big to save from the Mac for now (the limit is 150 MB). Add it in the CRM." }
  return { ok: true, cleanName: name }
}

/** How much one Mac may upload per hour (STORAGE_APP_WRITE_LIMIT_MB, default 500). */
export const DEFAULT_WRITE_LIMIT_MB = 500
export function writeLimitBytes(envValue: string | undefined = process.env.STORAGE_APP_WRITE_LIMIT_MB): number {
  const n = Number(envValue)
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_WRITE_LIMIT_MB) * 1024 * 1024
}
