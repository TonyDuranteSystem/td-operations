/**
 * Sending an attachment or voice note from the CRM on the self-hosted WhatsApp line — pure helpers (no I/O,
 * unit-tested). Antonio 2026-09-27: an upload button for ANY attachment (audio -> sent as a voice note, photos,
 * video, documents); dangerous file types blocked; no length limit of ours (only the technical size ceiling).
 *
 * The storage path is ALWAYS built here from (channel, client message id) — the same formula the database
 * function `wabridge_enqueue_send` uses — so the browser, the upload route and the database can never disagree
 * about where a file lives, and a retry with the same client message id can never produce two stored files.
 */

export const WA_OUTBOUND_BUCKET = "wa-voice"
/** Matches the migration's bucket file_size_limit — our own operational ceiling, not a WhatsApp rule. */
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024

export type AttachmentKind = "voice" | "image" | "video" | "document"

// The WhatsApp program picks how to handle a file by the EXTENSION on its URL, not its declared content type —
// a generic extension makes it refuse image/video/document sends outright (confirmed 2026-09-27: "unsupported
// file type: .bin"). This map is the SINGLE source of truth for the extension; the database function
// (wabridge_enqueue_send) carries the exact same mapping and MUST be kept in step with this one by hand — the
// two cannot share code, since one runs in the database and one in the browser/server.
const MIME_EXTENSION: Record<string, string> = {
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/webm": "weba",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain": "txt",
  "text/csv": "csv",
}

/** The ONE place the outgoing storage path is built. Mirrors the SQL formula in wabridge_enqueue_send exactly —
 *  including the extension, which the WhatsApp program requires to be real (see MIME_EXTENSION above). */
export function buildOutboundPath(channelId: string, clientMsgId: string, mime: string | null | undefined): string {
  const ext = MIME_EXTENSION[(mime ?? "").toLowerCase().trim()] ?? "bin"
  return `outbound/${channelId}/${clientMsgId}.${ext}`
}

const AUDIO_MIMES = new Set(["audio/mp4", "audio/x-m4a", "audio/aac", "audio/ogg", "audio/webm", "audio/mpeg", "audio/wav"])
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"])
const VIDEO_MIMES = new Set(["video/mp4", "video/quicktime", "video/webm"])
const DOCUMENT_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
])

/** What kind of WhatsApp send a file's mime type becomes. An audio file is sent as a voice note. Unknown mime = null (refused). */
export function kindForMime(mime: string | null | undefined): AttachmentKind | null {
  const m = (mime ?? "").toLowerCase().trim()
  if (!m) return null
  if (AUDIO_MIMES.has(m)) return "voice"
  if (IMAGE_MIMES.has(m)) return "image"
  if (VIDEO_MIMES.has(m)) return "video"
  if (DOCUMENT_MIMES.has(m)) return "document"
  return null
}

// Executables, scripts and installers — blocked outright regardless of what the browser reports as the mime type,
// since a renamed file can lie about its mime. Checked by EXTENSION, case-insensitively, on the filename only.
const DANGEROUS_EXTENSIONS = new Set([
  "exe", "bat", "cmd", "com", "msi", "msp", "scr", "pif", "vb", "vbs", "vbe", "js", "jse", "ws", "wsf", "wsc", "wsh",
  "ps1", "ps1xml", "ps2", "ps2xml", "psc1", "psc2", "msh", "msh1", "msh2", "mshxml", "msh1xml", "msh2xml",
  "scf", "lnk", "inf", "reg", "jar", "app", "dmg", "pkg", "apk", "ipa", "sh", "bash", "zsh", "command", "action",
  "workflow", "gadget", "cpl", "hta", "isu", "job", "msc", "mst", "sct", "shb", "shs", "vxd", "url",
])

/** True when the file name's extension is on the blocked (executable/script/installer) list. */
export function isDangerousFileName(fileName: string | null | undefined): boolean {
  const name = (fileName ?? "").trim()
  if (!name) return false
  const ext = name.split(".").pop()
  if (!ext || ext === name) return false // no extension at all — not flagged as dangerous by this check
  return DANGEROUS_EXTENSIONS.has(ext.toLowerCase())
}

export interface AttachmentValidation {
  ok: boolean
  /** Present only when ok is false. */
  error?: string
  kind?: AttachmentKind
}

/** The one place every rule for an outgoing attachment is checked, before an upload link is ever minted. */
export function validateOutboundAttachment(input: { fileName: string | null | undefined; fileSize: number; mimeType: string | null | undefined }): AttachmentValidation {
  if (isDangerousFileName(input.fileName)) {
    return { ok: false, error: "That file type is not allowed for security reasons." }
  }
  const kind = kindForMime(input.mimeType)
  if (!kind) {
    return { ok: false, error: "That file type is not supported yet." }
  }
  if (!Number.isFinite(input.fileSize) || input.fileSize < 1) {
    return { ok: false, error: "The file appears to be empty." }
  }
  if (input.fileSize > MAX_ATTACHMENT_BYTES) {
    const mb = (MAX_ATTACHMENT_BYTES / 1024 / 1024).toFixed(0)
    return { ok: false, error: `That file is too large (${mb} MB maximum).` }
  }
  return { ok: true, kind }
}
