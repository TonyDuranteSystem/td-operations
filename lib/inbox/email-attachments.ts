/**
 * Resolve what's attached to an open email, for the Inbox worker panel.
 *
 * Lives in lib/ (not inside the route) so it can be driven by tests — the caps
 * and the signature-logo filter are exactly the kind of thing that rots
 * silently.
 */
import { createHash } from "crypto"
import {
  extractAttachments,
  extractInlineImages,
  getGmailAttachment,
  type GmailAPIMessage,
} from "@/lib/gmail"
import { buildImageBlock, MAX_IMAGE_BYTES } from "@/lib/ai-agent/attachment-reader"
import type { WorkerImageBlock, PinnedEmailAttachment } from "@/lib/ai-agent/worker-tools"

/**
 * Images below this are almost always logos and tracking pixels that slipped
 * past the inline filter. A real screenshot is comfortably larger.
 *
 * Gmail sometimes reports size 0. A 0 is NOT treated as "tiny" — we genuinely
 * don't know — so those are fetched and judged on their actual bytes.
 */
export const MIN_MEANINGFUL_IMAGE_BYTES = 8 * 1024
/** Images attached to the user turn per call — each one is re-sent every loop iteration. */
export const MAX_EMAIL_IMAGES = 3
/** Documents offered to read_email_attachment. Metadata only; nothing is downloaded up-front. */
export const MAX_EMAIL_DOCUMENTS = 8
/** Hard ceiling on attachments we will even look at, before any filtering. */
export const MAX_EMAIL_ATTACHMENTS_SCANNED = 40

export interface EmailAttachmentHarvest {
  imageBlocks: WorkerImageBlock[]
  pinned: PinnedEmailAttachment[]
  note: string
}

/**
 * A stable handle for one attachment, derived from Gmail's own attachment id.
 *
 * NOT positional. The attachment list is re-harvested on every turn from a
 * moving window of the thread's last messages, so `att1` would silently point at
 * a different document once a new message arrives mid-conversation — while the
 * turn-1 text naming `att1` is still replayed from the stored transcript. A
 * content-derived ref either resolves to the same file or doesn't resolve.
 */
export function attachmentRef(attachmentId: string): string {
  return `att_${createHash("sha1").update(attachmentId).digest("hex").slice(0, 8)}`
}

/**
 * Two different treatments, on purpose:
 *  - IMAGES are downloaded and attached to the user turn, so the worker simply
 *    SEES them. A tool it has to choose to call is a tool it will skip, and then
 *    it answers about a screenshot it never looked at.
 *  - DOCUMENTS are only LISTED, with a server-minted ref. Auto-extracting a
 *    40-page PDF on every email the panel is opened on would burn tokens on the
 *    majority of turns that never mention it. The worker pulls one on demand.
 *
 * Messages are walked NEWEST-FIRST. The image budget is 3, and a corporate
 * footer can carry several images per message: walking oldest-first let logos
 * from four older replies fill every slot before reaching the newest message —
 * the one holding the screenshot the staff member is actually asking about.
 *
 * `mailboxAddress` is stamped onto every pinned entry: it is the mailbox the
 * SERVER authorized for this request, never anything the caller or the model
 * supplied, and it is what the later download runs as.
 *
 * Best-effort per attachment: one bad download must not cost the staff member
 * their answer.
 */
export async function harvestEmailAttachments(
  msgs: GmailAPIMessage[],
  mailboxAddress: string,
): Promise<EmailAttachmentHarvest> {
  const imageBlocks: WorkerImageBlock[] = []
  const pinned: PinnedEmailAttachment[] = []
  const imageNames: string[] = []
  const skipped: string[] = []
  let scanned = 0

  // Newest first — the screenshot being asked about is on the latest message.
  for (const m of [...msgs].reverse()) {
    if (!m.payload) continue

    // Parts carrying a Content-ID are inline images the HTML body references:
    // signature logos, social icons, tracking pixels. extractAttachments cannot
    // tell them apart from a real attachment, so exclude them explicitly.
    const inlineIds = new Set(extractInlineImages(m.payload).map((i) => i.attachmentId))

    for (const att of extractAttachments(m.payload)) {
      if (scanned >= MAX_EMAIL_ATTACHMENTS_SCANNED) break
      scanned++
      if (inlineIds.has(att.attachmentId)) continue // embedded in the email body, not an attachment

      const isImage = (att.mimeType ?? "").startsWith("image/")

      if (isImage) {
        // size 0 = Gmail didn't tell us; fetch and judge on the bytes.
        if (att.size > 0 && att.size < MIN_MEANINGFUL_IMAGE_BYTES) continue // logo/pixel that dodged the inline filter
        if (att.size > MAX_IMAGE_BYTES) {
          // Known-oversized: don't spend the download only to reject it.
          skipped.push(`${att.filename} (too large to look at)`)
          continue
        }
        if (imageBlocks.length >= MAX_EMAIL_IMAGES) {
          skipped.push(att.filename)
          continue
        }
        try {
          const { data } = await getGmailAttachment(m.id, att.attachmentId, mailboxAddress)
          const block = buildImageBlock(data)
          if (block) {
            imageBlocks.push(block)
            imageNames.push(att.filename)
          } else {
            skipped.push(`${att.filename} (too large or not a readable image)`)
          }
        } catch (err) {
          console.warn(`[email-attachments] image download failed for ${att.filename}:`, err)
          skipped.push(`${att.filename} (couldn't download)`)
        }
        continue
      }

      if (pinned.length >= MAX_EMAIL_DOCUMENTS) {
        skipped.push(att.filename)
        continue
      }
      pinned.push({
        ref: attachmentRef(att.attachmentId),
        messageId: m.id,
        attachmentId: att.attachmentId,
        mailbox: mailboxAddress,
        name: att.filename,
        mimetype: att.mimeType,
        size: att.size,
      })
    }
  }

  const lines: string[] = []
  if (imageNames.length) {
    lines.push(`Images (already shown to you above — look at them directly): ${imageNames.join(", ")}`)
  }
  if (pinned.length) {
    lines.push("Documents — call read_email_attachment with the ref to read one:")
    for (const a of pinned) {
      lines.push(`  ${a.ref} — ${a.name} (${a.mimetype}, ${Math.max(1, Math.round(a.size / 1024))} KB)`)
    }
  }
  // Say what was dropped. A silent cap reads as "there was nothing else".
  if (skipped.length) lines.push(`Not available: ${skipped.join(", ")}.`)

  const note = lines.length ? `\n\n--- ATTACHMENTS ON THIS EMAIL ---\n${lines.join("\n")}` : ""
  return { imageBlocks, pinned, note }
}
