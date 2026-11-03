/**
 * Bank application intake — where a SUBMITTED application is on its way out (Antonio 2026-11-02: nothing goes to the bank
 * contact until we have looked at it). PURE + client-safe: the staff page, the Calendar tab and the server all read the
 * same answer from the same row.
 *
 *   needs_review   submitted, nobody has looked at it yet
 *   ready          marked Reviewed; the Submit button is enabled
 *   sending        the Submit email is being sent right now
 *   send_failed    the Submit email did not go; pressing Submit again retries (it is the only retry)
 *   sent           submitted to the bank contact
 *   sent_back      staff sent it back to the client; the replacement link carries on from here
 *
 * The allowed values live here, not in a database CHECK (a CHECK list on the shared database turns other sessions' CI red).
 * An application that was emailed under the OLD rule (email_status = 'sent', no reviewed_at) is simply `sent`.
 */

export type ReviewState = "needs_review" | "ready" | "sending" | "send_failed" | "sent" | "sent_back"

export interface ReviewRow {
  status: string
  email_status: string | null
  reviewed_at?: string | null
  returned_at?: string | null
  /** Only needed to tell a send that never finished (see isStaleSending). */
  updated_at?: string | null
  /** Only needed to tell a failed send that Gmail never confirmed (see sendMayHaveGoneOut). */
  email_error?: string | null
}

/** A Submit that has been "sending" for longer than this never finished: deliver.ts then lets Submit take it over. */
export const STALE_SENDING_MS = 5 * 60 * 1000

/**
 * A send that started and never recorded its outcome (the request died, or the final database write failed). The email MAY
 * already have reached the bank contact, so the staff page asks the person to check the Sent mailbox before pressing Submit
 * again — a retry is never silent.
 */
export function isStaleSending(r: ReviewRow, now: number = Date.now()): boolean {
  if (r.email_status !== "sending" || !r.updated_at) return false
  const t = Date.parse(r.updated_at)
  return Number.isFinite(t) && now - t > STALE_SENDING_MS
}

/**
 * deliver.ts starts `email_error` with this when the send failed AFTER the hand-off to Gmail began (a dropped connection, a
 * server error, an unreadable reply). Google may have accepted the message anyway, so "failed" does not prove nothing went out.
 * A failure BEFORE the hand-off (a file could not be read, a bad address) never carries it: that one definitely did not go.
 * It is plain text in the existing column on purpose: no database change, and the list and detail screens already show it.
 */
export const SEND_UNCONFIRMED_PREFIX = "Gmail did not confirm the send, so the email may already have reached the bank contact. Check the Sent mailbox before submitting again. "

/**
 * Gmail looked at the message and REFUSED it: an answer in the 400s ("too big", "not authorised", "bad address"), as lib/gmail.ts
 * words it ("Gmail API 400: …"). Nothing went out, so that failure is a plain retry. Not a refusal: a timeout (408), a server
 * error (5xx), a dropped connection, an unreadable reply, or anything we do not recognise — those are "not confirmed".
 */
export function gmailRefusedTheSend(message: string): boolean {
  const m = /^Gmail API (\d{3})\b/.exec(message)
  if (!m) return false
  const status = Number(m[1])
  return status >= 400 && status < 500 && status !== 408
}

/**
 * The email MAY already be at the bank contact: either a send that never recorded its outcome (stale 'sending'), or a failure
 * Gmail never confirmed. In both cases pressing Submit again could email every passport a second time, so the staff page asks
 * the person to check the Sent mailbox first. A failure that definitely did not go out (no prefix) is a plain retry.
 */
export function sendMayHaveGoneOut(r: ReviewRow, now: number = Date.now()): boolean {
  if (isStaleSending(r, now)) return true
  return r.email_status === "failed" && (r.email_error ?? "").startsWith(SEND_UNCONFIRMED_PREFIX)
}

/** null = not a submitted application (not opened, being filled, revoked). */
export function reviewState(r: ReviewRow): ReviewState | null {
  if (r.status !== "completed") return null
  if (r.returned_at) return "sent_back"
  if (r.email_status === "sent") return "sent"
  if (r.email_status === "sending") return "sending"
  if (r.email_status === "failed") return "send_failed"
  return r.reviewed_at ? "ready" : "needs_review"
}

/** The states that are still on staff's desk: they show in the Calendar tab until the application leaves. */
export const WAITING_STATES: readonly ReviewState[] = ["needs_review", "ready", "sending", "send_failed"]

export function isWaitingForStaff(r: ReviewRow): boolean {
  const s = reviewState(r)
  return !!s && WAITING_STATES.includes(s)
}

export const REVIEW_STATE_TEXT: Record<ReviewState, string> = {
  needs_review: "Needs review",
  ready: "Reviewed, ready to submit",
  sending: "Submitting…",
  send_failed: "Submit failed, try again",
  sent: "Submitted",
  sent_back: "Sent back to the client",
}

/**
 * Review can be marked on an application nobody has looked at, sent or sent back. A row whose old automatic send failed (or
 * stalled) before the review step existed has no review either, so it may be reviewed too — otherwise it could never be submitted.
 */
export function canMarkReviewed(r: ReviewRow): boolean {
  if (r.reviewed_at) return false
  const s = reviewState(r)
  return s === "needs_review" || s === "send_failed" || s === "sending"
}

/** Submit needs Reviewed first; a failed send may be retried, and so may one that stalled for over 5 minutes (the server enforces that too). */
export function canSubmit(r: ReviewRow, now?: number): boolean {
  if (!r.reviewed_at) return false
  const s = reviewState(r)
  return s === "ready" || s === "send_failed" || (s === "sending" && isStaleSending(r, now))
}

/** Sending back is possible until it has been sent back; it also works AFTER it was submitted (the bank may ask for a correction later). */
export function canSendBack(r: ReviewRow): boolean {
  const s = reviewState(r)
  return !!s && s !== "sent_back" && s !== "sending"
}
