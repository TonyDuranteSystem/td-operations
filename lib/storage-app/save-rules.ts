/**
 * Saving a NEW file from a Mac into the storage (dev job 1992a087, phase P3 step A). PURE rules — no database, no network.
 * Step A only saves into the firm's own areas (Business, a staff member's My files); client and person storages come in a later step.
 */
import { isInternalOwnerKind } from "@/lib/crm-store/plain-drop"

import { clientSaveAllowed, type ClientSaves } from "./settings"

/** What counts as a CLIENT storage (a file saved from a Mac there needs its "Needs review" mark and its documents row). WHICH of them, and which folders, a Mac may save into is the `clientSaves` setting (lib/storage-app/settings.ts). */
export const CLIENT_OWNER_KINDS: ReadonlySet<string> = new Set(["company", "person", "formation"])
export const isClientOwnerKind = (kind: string | null | undefined): boolean => !!kind && CLIENT_OWNER_KINDS.has(kind)

/** The CRM writer's inline-registration cap: the ABSOLUTE ceiling for one saved file (the `maxSaveMB` setting can only lower it). */
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
export function checkDestination(p: {
  ownerKind: string | null | undefined; folderKind: string | null | undefined; inStaffShare: boolean; folderTrashed: boolean
  /** the settings row's `clientSaves` + the ids that identify THIS storage (store owner id / account id / contact id) */
  clientSaves: ClientSaves; ownerIds?: { ownerId?: string | null; accountId?: string | null; contactId?: string | null }
}): SaveRefusal {
  if (p.folderTrashed) return { ok: false, code: "not_found", message: "That folder is in the trash." }
  if (/(^|_)root$/.test(p.folderKind ?? "")) return { ok: false, code: "not_allowed", message: "Open one of the folders first — files go inside a folder, not at the top." }
  if (p.folderKind === "contacts") return { ok: false, code: "not_allowed", message: "People's documents are added in the CRM, not from the Mac." }
  if (p.inStaffShare) return { ok: false, code: "not_allowed", message: "\"Shared with staff\" is managed in the CRM." }
  if (isInternalOwnerKind(p.ownerKind)) return { ok: true }
  if (isClientOwnerKind(p.ownerKind)) {
    if (!clientSaveAllowed(p.clientSaves, { kind: p.ownerKind, ...p.ownerIds })) return { ok: false, code: "not_allowed", message: "Saving into this client's folders from the Mac is not switched on." }
    if (!p.clientSaves.folderKinds.includes(p.folderKind ?? "")) return { ok: false, code: "not_allowed", message: "Saving into this kind of folder from the Mac is not switched on." }
    return { ok: true }
  }
  return { ok: false, code: "not_allowed", message: "Saving here from the Mac is not available." }
}

export function checkNewFile(p: { name: unknown; size: unknown }, maxBytes: number = MAX_SAVE_BYTES): SaveRefusal & { cleanName?: string } {
  const name = cleanFileName(p.name)
  if (!name) return { ok: false, code: "bad_name", message: "This file name cannot be used." }
  if (isJunkName(name)) return { ok: false, code: "ignored", message: "This is a system or temporary file — it is not saved." }
  if (typeof p.size !== "number" || !Number.isFinite(p.size) || p.size < 0) return { ok: false, code: "bad_name", message: "The file size is missing." }
  if (p.size > maxBytes) return { ok: false, code: "too_big", message: `This file is too big to save from the Mac for now (the limit is ${Math.floor(maxBytes / (1024 * 1024))} MB). Add it in the CRM.` }
  return { ok: true, cleanName: name }
}
