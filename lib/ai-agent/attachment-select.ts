/**
 * Which email attachments to keep: the real files, not the tiny pictures embedded in the message body (signature logos,
 * image001.png). Pure. Nothing is dropped silently: skipped parts are always listed back.
 *
 * A picture counts as an embedded logo only when it carries a Content-ID AND is small. A photo that is big, or that has a
 * filename and no Content-ID, is a real file even when the mail app (iPhone Mail) marks it "inline".
 */

export const EMBEDDED_PICTURE_MAX_BYTES = 50 * 1024

export interface MailPartLike { mimeType?: string; headers?: Array<{ name?: string; value?: string }> }
export interface ListedAttachment { filename: string; mimeType: string; attachmentId: string; size: number; inline: boolean }

export function isInlineImagePart(part: MailPartLike, size: number): boolean {
  if (!/^image\//i.test(part.mimeType || "")) return false
  const header = (n: string) => (part.headers ?? []).find((h) => (h.name || "").toLowerCase() === n)?.value || ""
  const hasContentId = !!header("content-id").trim()
  return hasContentId && size <= EMBEDDED_PICTURE_MAX_BYTES
}

export function selectAttachmentsToSave(
  all: ListedAttachment[],
  opts: { attachment_id?: string | null; include_inline?: boolean },
): { picked: ListedAttachment[]; skipped: ListedAttachment[]; error?: string } {
  if (opts.attachment_id) {
    const one = all.find((a) => a.attachmentId === opts.attachment_id)
    return one
      ? { picked: [one], skipped: [] }
      : { picked: [], skipped: [], error: `No attachment with attachment_id ${opts.attachment_id} on this message (the ids can change - list the attachments again). Nothing was saved.` }
  }
  if (opts.include_inline) return { picked: all, skipped: [] }
  return { picked: all.filter((a) => !a.inline), skipped: all.filter((a) => a.inline) }
}
