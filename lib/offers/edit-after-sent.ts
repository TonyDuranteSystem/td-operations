/**
 * Claude's offer-edit tool (offer_update) on an offer that is no longer a draft (offer builder Part 3, item D, dev job d2971d11).
 *
 * A draft can be changed freely. An offer that is already out (sent, viewed, signed, completed, expired…) may have been seen
 * or signed by the client, so changing it needs a reason, and the reason is written to the activity log. NOT a ban: in the
 * last 120 days 6 of 15 edits were deliberate fix-ups on offers already out (currency, bank details, contract type, yearly
 * amounts). The rule makes the edit deliberate and visible, and makes Claude tell Antonio before doing it.
 */

/** Shortest reason that can be a real sentence ("fix currency" is not enough, "wrong currency typed at creation" is). */
export const MIN_EDIT_REASON_LENGTH = 15

/**
 * Setting an offer's status to "sent" by hand (offer builder Part 3, item "call 1", dev job d2971d11).
 *
 * The only honest way an offer becomes "sent" is Send (publishOffer -> markOfferSent): the Send checks pass, the client is emailed,
 * THEN the status is written. offer_update used to pass any field straight through, so {status: "sent"} flipped a draft with no
 * checks and no email (its own help text even used that as the example). Production history: 3 edits that touched status in 6
 * months, all on test offers — so nothing real depends on it. Other statuses stay editable (the duplicate-offer message tells
 * Claude to set an old offer to "expired"). An offer that is ALREADY "sent" may be re-saved as "sent" (no change).
 */
export function statusSetByHandProblem(p: { currentStatus: string | null | undefined; updates: Record<string, unknown> | null | undefined }): string | null {
  if (!p.updates || !Object.prototype.hasOwnProperty.call(p.updates, "status")) return null
  const wanted = typeof p.updates.status === "string" ? p.updates.status.trim().toLowerCase() : ""
  if (wanted !== "sent") return null
  const current = typeof p.currentStatus === "string" ? p.currentStatus.trim().toLowerCase() : ""
  if (current === "sent") return null
  return (
    `Setting an offer's status to "sent" by hand skips the Send checks and emails nobody, so the offer would look sent while the client was never told. ` +
    `Nothing was changed. To send it use offer_send (it runs the checks, emails the client and marks it sent), or offer_resend for an offer that is already sent. ` +
    `Everything else on the offer, and other statuses such as "expired", can still be changed with offer_update.`
  )
}

/** The message to hand back instead of editing, or null when the edit may go ahead. */
export function editReasonProblem(p: { status: string | null | undefined; reason: unknown }): string | null {
  const status = typeof p.status === "string" ? p.status.trim() : ""
  if (!status || status === "draft") return null // a draft, or an offer that was not found (the update reports that itself)
  const reason = typeof p.reason === "string" ? p.reason.trim() : ""
  if (reason.length >= MIN_EDIT_REASON_LENGTH) return null
  return (
    `This offer is already "${status}" — the client may have seen or signed it. Nothing was changed. ` +
    `Tell Antonio what you want to change and why, then call offer_update again with "reason": one clear sentence ` +
    `(at least ${MIN_EDIT_REASON_LENGTH} characters). The reason is saved in the activity log.`
  )
}
