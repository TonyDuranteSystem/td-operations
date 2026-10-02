/**
 * Storage path convention for portal chat attachments — shared so any new
 * writer (e.g. portal_chat_attach_file) lands files in the exact same shape
 * the client-upload routes already use and the chat UI already renders:
 *   chat-attachments/<accountId|contactId|"unknown">/<uuid>.<ext>
 * Mirrors app/api/portal/chat/upload-url/route.ts — kept as a separate
 * reference implementation rather than refactoring that route to import this,
 * since that route is live, working, client-facing code untouched by this change.
 */

import { randomUUID } from "crypto"

/** The path's directory segment — account-scoped thread, else the contact's own thread, else the same "unknown" fallback the uploader route uses. */
export function chatAttachmentDir(accountId: string | null, contactId: string | null): string {
  return accountId || contactId || "unknown"
}

/**
 * Lowercased, alphanumeric-only, length-capped extension from a filename —
 * sanitizes the STORAGE KEY (no traversal/weird characters), it does not
 * decide which file TYPES are safe to attach. Deliberately NOT an allow-list:
 * an allow-list here silently degraded real, common attachment types (e.g. a
 * phone-photographed passport, .heic) to a generic "bin" extension, breaking
 * inline rendering even though the real content-type was preserved — while
 * doing nothing an allow-list is actually for, since dangerous file types are
 * now rejected up front by validateChatAttachment() before this ever runs.
 * Matches app/api/portal/chat/upload-url/route.ts's exact sanitize shape.
 */
export function safeChatAttachmentExt(filename: string): string {
  return (filename.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin"
}

/** Full storage path for a new chat attachment. */
export function buildChatAttachmentPath(filename: string, accountId: string | null, contactId: string | null): string {
  const dir = chatAttachmentDir(accountId, contactId)
  const ext = safeChatAttachmentExt(filename)
  return `chat-attachments/${dir}/${randomUUID()}.${ext}`
}

/**
 * May the server convert THIS stored chat attachment (an iPhone photo → JPEG)? Only a file the uploader route made for this very
 * thread: chat-attachments/<thread dir>/<uuid>.heic|heif — never any other path of the bucket.
 */
export function convertibleChatPath(path: string, accountId: string | null, contactId: string | null): boolean {
  const dir = chatAttachmentDir(accountId, contactId)
  const m = /^chat-attachments\/([^/]+)\/([0-9a-f-]{36})\.(heic|heif)$/.exec(path)
  return !!m && m[1] === dir
}

/** The JPEG's path next to the HEIC: same folder, new random name. */
export function jpegPathBeside(path: string): string {
  return path.replace(/\/[0-9a-f-]{36}\.(heic|heif)$/, `/${randomUUID()}.jpg`)
}
