import { WORKER_UPLOAD_BUCKET } from "@/lib/ai-agent/attachment-reader"
import type { SendEmailAttachment } from "@/lib/operations/email"

/**
 * Staging for files a staff member attaches in the Inbox email composers
 * (new email + reply). The browser uploads bytes DIRECTLY to storage through a
 * signed URL (the platform's ~4.5MB request-body limit rules out posting them
 * to our API), then hands the send route the object PATHs; the server reads
 * the bytes back with the service key and attaches them to the outgoing MIME.
 *
 * Files live in the PRIVATE worker-attachments bucket (never served publicly —
 * an email attachment is routinely a client's passport or EIN letter) under
 * their own `inbox-email/` prefix so they can't collide with worker-panel
 * uploads. Staged objects are deleted after a successful send; a failed send
 * keeps them so a retry with the same paths still works.
 */

export const INBOX_EMAIL_BUCKET = WORKER_UPLOAD_BUCKET

/** Objects are minted server-side as `inbox-email/<uuid>.<ext>` — anything
 * else is a client-supplied path we did not create. The service-role client
 * bypasses RLS, so the path shape is the read gate. */
const INBOX_EMAIL_STAGING_PATH =
  /^inbox-email\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/i

export function isValidInboxEmailStagingPath(path: string): boolean {
  return INBOX_EMAIL_STAGING_PATH.test(path)
}

/** Gmail rejects messages over 25MB TOTAL after base64 (+~33%) — 18MB of raw
 * file bytes is the honest ceiling. Enforced per file AND across the batch. */
export const MAX_EMAIL_ATTACHMENT_TOTAL_BYTES = 18 * 1024 * 1024
export const MAX_EMAIL_ATTACHMENT_TOTAL_MB = 18
export const MAX_EMAIL_ATTACHMENT_FILES = 10

export interface StagedEmailAttachmentInput {
  path: string
  name: string
  mime_type?: string
}

/**
 * The filename is interpolated into MIME headers (Content-Type name= /
 * Content-Disposition filename=) by the send engine — quotes and line breaks
 * there are header injection, not decoration. Also RFC 2047-encodes non-ASCII
 * names so "Contratto società.pdf" survives instead of shipping mojibake.
 */
export function sanitizeAttachmentFilename(name: string): string {
  const cleaned = name
    .replace(/[\r\n"\\]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 180)
  const fallback = cleaned || "attachment"
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(fallback)) return fallback
  return `=?utf-8?B?${Buffer.from(fallback, "utf-8").toString("base64")}?=`
}

/** Parse + bound the raw `attachments` field of a compose/reply request body.
 * Returns null when the field is absent/empty; throws on a malformed entry. */
export function parseStagedAttachmentInputs(raw: unknown): StagedEmailAttachmentInput[] | null {
  if (raw == null) return null
  if (!Array.isArray(raw)) throw new Error("attachments must be a list")
  if (raw.length === 0) return null
  if (raw.length > MAX_EMAIL_ATTACHMENT_FILES) {
    throw new Error(`Too many attachments: ${raw.length} (max ${MAX_EMAIL_ATTACHMENT_FILES}).`)
  }
  return raw.map((entry) => {
    const e = entry as Record<string, unknown>
    const path = typeof e?.path === "string" ? e.path : ""
    const name = typeof e?.name === "string" ? e.name : ""
    if (!isValidInboxEmailStagingPath(path)) throw new Error("Invalid attachment reference.")
    return {
      path,
      name: sanitizeAttachmentFilename(name),
      mime_type: typeof e?.mime_type === "string" ? e.mime_type : undefined,
    }
  })
}

/**
 * Download staged uploads and shape them for the send engine. Size is checked
 * against the ACTUAL downloaded bytes — the client's declared sizes are a
 * courtesy, this is the control.
 */
export async function loadStagedEmailAttachments(
  inputs: StagedEmailAttachmentInput[]
): Promise<SendEmailAttachment[]> {
  const { supabaseAdmin } = await import("@/lib/supabase-admin")
  const out: SendEmailAttachment[] = []
  let totalBytes = 0
  for (const input of inputs) {
    if (!isValidInboxEmailStagingPath(input.path)) throw new Error("Invalid attachment reference.")
    const { data, error } = await supabaseAdmin.storage
      .from(INBOX_EMAIL_BUCKET)
      .download(input.path)
    if (error || !data) {
      throw new Error(
        `Attachment "${input.name || "file"}" is no longer available — please re-attach it and try again.`
      )
    }
    const buffer = Buffer.from(await data.arrayBuffer())
    totalBytes += buffer.length
    if (totalBytes > MAX_EMAIL_ATTACHMENT_TOTAL_BYTES) {
      throw new Error(
        `Attachments too large: over ${MAX_EMAIL_ATTACHMENT_TOTAL_MB} MB combined (Gmail's limit). Remove a file or send it via a Drive link.`
      )
    }
    out.push({
      filename: sanitizeAttachmentFilename(input.name),
      content: buffer.toString("base64"),
      content_type: input.mime_type || "application/octet-stream",
    })
  }
  return out
}

/** Best-effort cleanup after a SUCCESSFUL send. Never throws — the email is
 * already out; a leftover staged object is a non-event. */
export async function deleteStagedEmailAttachments(paths: string[]): Promise<void> {
  const valid = paths.filter(isValidInboxEmailStagingPath)
  if (!valid.length) return
  try {
    const { supabaseAdmin } = await import("@/lib/supabase-admin")
    await supabaseAdmin.storage.from(INBOX_EMAIL_BUCKET).remove(valid)
  } catch (err) {
    console.warn("[email-attachment-staging] cleanup failed:", err)
  }
}
