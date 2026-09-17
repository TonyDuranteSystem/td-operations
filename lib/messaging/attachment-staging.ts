import { WORKER_UPLOAD_BUCKET, MAX_ATTACHMENT_BYTES } from "@/lib/ai-agent/attachment-reader"
import { createRecordedSignedUrl } from "@/lib/storage/signed-download"

/**
 * Staging for a file attached in the "start a new WhatsApp conversation"
 * popup. The browser uploads directly to storage via a signed URL, then hands
 * the send route the object PATH; at send time we mint a time-boxed signed
 * DOWNLOAD url for 2Chat's own servers to fetch — never a permanent public
 * one.
 *
 * Lands in the PRIVATE `worker-attachments` bucket (the codebase's existing
 * safe pattern for this content class — an attachment here is routinely an ID
 * a lead already shared), under its own `whatsapp-new/` prefix so it can't
 * collide with worker-panel or inbox-email uploads. A signed URL is
 * unavoidably a real, if time-boxed, exposure once handed to a third party
 * (2Chat, then the recipient's WhatsApp client) — this is a deliberate,
 * Antonio-approved trade-off for this feature, not an oversight.
 */

export const WHATSAPP_ATTACHMENT_BUCKET = WORKER_UPLOAD_BUCKET
export { MAX_ATTACHMENT_BYTES as MAX_WHATSAPP_ATTACHMENT_BYTES }

/** Uploads are minted server-side as `whatsapp-new/<uuid>.<ext>` — nothing else. */
const WHATSAPP_ATTACHMENT_PATH =
  /^whatsapp-new\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$/i

export function isValidWhatsAppAttachmentPath(path: string): boolean {
  return WHATSAPP_ATTACHMENT_PATH.test(path)
}

/**
 * A signed URL needs enough time to survive 2Chat queueing the send (their own
 * API response says a send may be "batched", i.e. not necessarily fetched the
 * instant we call — see docs/systems/messaging.md), while still being bounded
 * rather than permanent. 24 hours matches this codebase's existing precedent
 * for a similar-risk attachment class.
 */
export const WHATSAPP_ATTACHMENT_URL_TTL_SECONDS = 60 * 60 * 24

/**
 * Turn a staged upload path into a URL 2Chat can actually fetch. Returns null
 * (fail closed) for an invalid path or a storage error — callers must treat
 * that as "the attachment can't be sent," never silently drop it.
 */
export async function resolveWhatsAppAttachmentUrl(path: string): Promise<string | null> {
  if (!isValidWhatsAppAttachmentPath(path)) return null
  return createRecordedSignedUrl(WHATSAPP_ATTACHMENT_BUCKET, path, WHATSAPP_ATTACHMENT_URL_TTL_SECONDS)
}
