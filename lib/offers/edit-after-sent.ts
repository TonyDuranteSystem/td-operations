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
