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

const SAFE_EXTENSIONS = ["pdf", "jpg", "jpeg", "png", "webp", "gif", "doc", "docx", "xls", "xlsx", "txt", "csv"]

/** The path's directory segment — account-scoped thread, else the contact's own thread, else the same "unknown" fallback the uploader route uses. */
export function chatAttachmentDir(accountId: string | null, contactId: string | null): string {
  return accountId || contactId || "unknown"
}

/** Lowercased, alphanumeric-only extension from a filename, restricted to the same allow-list the client-upload route enforces. Falls back to "bin" for anything else (never trust a caller-supplied extension into a storage path). */
export function safeChatAttachmentExt(filename: string): string {
  const rawExt = (filename.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "")
  return SAFE_EXTENSIONS.includes(rawExt) ? rawExt : "bin"
}

/** Full storage path for a new chat attachment. */
export function buildChatAttachmentPath(filename: string, accountId: string | null, contactId: string | null): string {
  const dir = chatAttachmentDir(accountId, contactId)
  const ext = safeChatAttachmentExt(filename)
  return `chat-attachments/${dir}/${randomUUID()}.${ext}`
}
