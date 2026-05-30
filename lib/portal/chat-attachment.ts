/**
 * Portal chat attachments — shared validation + client-side upload helper.
 *
 * Single source of truth for the chat attachment rules so the client portal
 * chat and the two staff chat senders never drift apart:
 *   - components/portal/portal-chat.tsx        (client)
 *   - app/(dashboard)/portal-chats/page.tsx    (staff CRM inbox)
 *   - components/contacts/contact-detail.tsx   (staff contact chat)
 *
 * Why this exists: chat attachments used to POST the file through our own
 * serverless function (`/api/portal/chat/upload`), which is subject to the
 * platform request-body limit (the codebase's documents/upload-url route
 * notes a Vercel 4.5MB limit). A phone passport photo (4-8MB) or a PDF scan
 * falls in the gap between that platform limit and the old 10MB app cap, so it
 * passed the app check but died at the platform — surfacing only "Upload failed".
 *
 * The fix: upload the bytes DIRECTLY to Supabase Storage via a short-lived
 * signed URL (`/api/portal/chat/upload-url`), bypassing the function entirely.
 * That removes the platform ceiling; the real size guard becomes the `assets`
 * bucket's file_size_limit (set to CHAT_ATTACHMENT_MAX_MB).
 *
 * Type policy (per Antonio, 2026-05-30): allow any NORMAL file (images incl.
 * HEIC, PDFs, Office docs, archives, audio/video) but BLOCK active-content /
 * executable types, because attachments live on a PUBLIC bucket URL.
 */
import type { ChatAttachment } from '@/lib/types'

export const CHAT_ATTACHMENT_MAX_MB = 100
export const CHAT_ATTACHMENT_MAX_BYTES = CHAT_ATTACHMENT_MAX_MB * 1024 * 1024

/**
 * Extensions blocked because they can execute / carry active content when
 * served from a public URL. NOT an allow-list — everything else is permitted.
 */
export const BLOCKED_EXTENSIONS = new Set<string>([
  // markup / active web content
  'html', 'htm', 'xhtml', 'shtml', 'svg', 'xml', 'xht',
  // scripts
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vbs', 'vbe', 'wsf', 'wsh',
  'ps1', 'psm1', 'sh', 'bash', 'zsh', 'php', 'phtml', 'asp', 'aspx',
  'jsp', 'cgi', 'pl', 'py', 'rb',
  // executables / installers / libraries
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'jar', 'app', 'dmg',
  'apk', 'deb', 'rpm', 'dll', 'so', 'bin',
])

/**
 * MIME types blocked for the same reason. Belt-and-suspenders alongside the
 * extension list — a file can lie about one but rarely both.
 */
export const BLOCKED_MIME_TYPES = new Set<string>([
  'text/html', 'application/xhtml+xml', 'image/svg+xml',
  'text/javascript', 'application/javascript', 'application/x-javascript',
  'application/ecmascript', 'text/ecmascript',
  'application/x-msdownload', 'application/x-msdos-program',
  'application/x-executable', 'application/vnd.microsoft.portable-executable',
  'application/x-sh', 'application/x-shellscript',
  'application/x-httpd-php', 'application/java-archive',
])

/** Lower-cased, punctuation-stripped extension (no leading dot). '' if none. */
export function getExtension(fileName: string): string {
  const parts = (fileName || '').split('.')
  if (parts.length < 2) return ''
  return (parts.pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Validate a chat attachment against the size cap and the active-content
 * block-list. Pure — safe to call on both client and server.
 * Returns a user-friendly error message, or null when the file is allowed.
 */
export function validateChatAttachment(
  fileName: string,
  sizeBytes: number,
  mimeType: string,
): string | null {
  if (sizeBytes > CHAT_ATTACHMENT_MAX_BYTES) {
    const mb = (sizeBytes / 1024 / 1024).toFixed(1)
    return `File too large: ${mb} MB. Maximum allowed: ${CHAT_ATTACHMENT_MAX_MB} MB.`
  }
  const ext = getExtension(fileName)
  const mime = (mimeType || '').toLowerCase().split(';')[0].trim()
  if ((ext && BLOCKED_EXTENSIONS.has(ext)) || (mime && BLOCKED_MIME_TYPES.has(mime))) {
    return "This file type can't be sent in chat for security reasons. PDFs, images, and documents are all fine."
  }
  return null
}

/**
 * Upload a single file to chat storage via a signed URL (browser-only).
 * Throws Error(<user-friendly message>) on any failure — callers surface
 * err.message directly (R099: never collapse to a generic toast).
 *
 * Pass whichever of accountId / contactId scopes the thread (mirrors the chat
 * send route): account threads pass accountId; contact-only threads pass
 * contactId.
 */
export async function uploadChatAttachment(
  file: File,
  ctx: { accountId?: string | null; contactId?: string | null },
): Promise<ChatAttachment> {
  const validationError = validateChatAttachment(file.name, file.size, file.type)
  if (validationError) throw new Error(validationError)

  // 1. Ask the server for a signed upload URL (cheap JSON request — never
  //    streams the file through the function).
  const urlRes = await fetch('/api/portal/chat/upload-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      account_id: ctx.accountId || undefined,
      contact_id: ctx.contactId || undefined,
      file_name: file.name,
    }),
  })
  if (!urlRes.ok) {
    const d = await urlRes.json().catch(() => ({}))
    throw new Error(d.error || 'Could not start the upload. Please try again.')
  }
  const { signedUrl, publicUrl } = await urlRes.json()
  if (!signedUrl || !publicUrl) {
    throw new Error('Could not start the upload. Please try again.')
  }

  // 2. PUT the bytes straight to Storage. The bucket size limit returns 413
  //    if the file exceeds the cap (server-side enforcement).
  const putRes = await fetch(signedUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  })
  if (!putRes.ok) {
    if (putRes.status === 413) {
      throw new Error(`File too large. Maximum allowed: ${CHAT_ATTACHMENT_MAX_MB} MB.`)
    }
    throw new Error('Upload failed. Please check your connection and try again.')
  }

  return {
    url: publicUrl,
    name: file.name,
    mime_type: file.type || undefined,
    size: file.size,
  }
}
