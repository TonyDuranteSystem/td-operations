/**
 * Which email attachments to keep: the real files, not the pictures embedded in the message body (signature logos,
 * image001.png). Pure.
 */

export interface MailPartLike { mimeType?: string; headers?: Array<{ name?: string; value?: string }> }
export interface ListedAttachment { filename: string; mimeType: string; attachmentId: string; size: number; inline: boolean }

/** An image that belongs to the message body: it carries a Content-ID or is marked inline. */
export function isInlineImagePart(part: MailPartLike): boolean {
  if (!/^image\//i.test(part.mimeType || "")) return false
  const header = (n: string) => (part.headers ?? []).find((h) => (h.name || "").toLowerCase() === n)?.value || ""
  return !!header("content-id").trim() || /^\s*inline/i.test(header("content-disposition"))
}

export function selectAttachmentsToSave(
  all: ListedAttachment[],
  opts: { attachment_id?: string | null; include_inline?: boolean },
): { picked: ListedAttachment[]; error?: string } {
  if (opts.attachment_id) {
    const one = all.find((a) => a.attachmentId === opts.attachment_id)
    return one ? { picked: [one] } : { picked: [], error: `No attachment with attachment_id ${opts.attachment_id} on this message. Nothing was saved.` }
  }
  return { picked: opts.include_inline ? all : all.filter((a) => !a.inline) }
}
