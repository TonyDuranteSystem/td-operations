/**
 * The words a person typed under a photo or video (Antonio, 2026-11-06: a photo sent from the phone with "it seems they can't send the OTP"
 * showed in the Inbox without its words — the words were saved, the screen never drew them).
 * The system saves a stand-in text when there is no caption (`[Photo]`, `[Video]`, `[Sticker]`, `[Voice note]`, `[Document]`, `[Document: file.pdf]`):
 * that is not a caption and must not be shown as one. Anything else is the person's own words.
 */
const PLACEHOLDER = /^\[(photo|image|video|sticker|voice note|audio|document(: .*)?)\]$/i

export function mediaCaption(contentText: string | null | undefined): string | null {
  const t = (contentText ?? '').trim()
  if (!t || PLACEHOLDER.test(t)) return null
  return t
}
