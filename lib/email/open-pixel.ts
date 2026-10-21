/**
 * The ONE place an open-tracking picture (a 1x1 invisible image) can be put into an email (dev job 1a23f5f1 / e5d5400d).
 *
 * It is SWITCHED OFF. Why: a per-recipient open pixel needs the recipient's prior consent under the Italian Garante's
 * provv. n. 284 of 17 Apr 2026 (deadline 28 Oct 2026) and the CNIL's April 2026 recommendation, and many of our clients and
 * leads are in Italy; Resend also flags an image hosted off the sending domain. Client invoice emails already dropped it.
 *
 * What stays: every `email_tracking` row (it is the record that an email was sent, used for duplicate detection and the lead
 * timeline) and the `/api/track/open/<id>` route (emails already in inboxes still call it). What stops: no new email carries
 * the image, so "opened" is no longer recorded for new emails. Offers, leases, operating agreements and e-sign pages record
 * their OWN view when the client opens the link (offer view_count / viewed_at etc.), which is a separate signal.
 *
 * To bring it back (only after a consent decision), flip the constant and update tests/unit/email-no-open-pixel.test.ts.
 */
export const OPEN_PIXEL_ENABLED = false

/** Emails created on or after this date were sent with the pixel switched off (their 'opened' is never recorded). */
export const OPEN_PIXEL_OFF_SINCE = '2026-10-21'

/** The invisible image tag, or an empty string while the pixel is switched off. */
export function openPixelImg(url: string | null | undefined): string {
  if (!OPEN_PIXEL_ENABLED || !url) return ''
  const safe = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  return `<img src="${safe}" width="1" height="1" style="display:none" alt="" />`
}
