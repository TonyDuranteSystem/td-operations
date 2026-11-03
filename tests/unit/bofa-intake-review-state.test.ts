import { describe, it, expect } from "vitest"
import { REVIEW_STATE_TEXT, SEND_UNCONFIRMED_PREFIX, STALE_SENDING_MS, WAITING_STATES, canMarkReviewed, canSendBack, canSubmit, gmailRefusedTheSend, isStaleSending, isWaitingForStaff, reviewState, sendMayHaveGoneOut, canUndoSendBack, undoSendBackBlock } from "@/lib/bofa-intake/review-state"

const done = (over: Partial<Parameters<typeof reviewState>[0]> = {}) => ({ status: "completed", email_status: null, reviewed_at: null, returned_at: null, ...over })

describe("reviewState", () => {
  it("is null for anything the client has not submitted", () => {
    for (const status of ["pending", "opened", "revoked"]) expect(reviewState(done({ status }))).toBeNull()
  })

  it("walks needs_review → ready → sending → sent", () => {
    expect(reviewState(done())).toBe("needs_review")
    expect(reviewState(done({ reviewed_at: "2026-11-02T10:00:00Z" }))).toBe("ready")
    expect(reviewState(done({ reviewed_at: "2026-11-02T10:00:00Z", email_status: "sending" }))).toBe("sending")
    expect(reviewState(done({ reviewed_at: "2026-11-02T10:00:00Z", email_status: "sent" }))).toBe("sent")
  })

  it("an application emailed under the OLD rule (sent, never reviewed) is simply submitted", () => {
    expect(reviewState(done({ email_status: "sent" }))).toBe("sent")
    expect(isWaitingForStaff(done({ email_status: "sent" }))).toBe(false)
  })

  it("a failed submit stays on staff's desk and may be pressed again", () => {
    const r = done({ reviewed_at: "x", email_status: "failed" })
    expect(reviewState(r)).toBe("send_failed")
    expect(isWaitingForStaff(r)).toBe(true)
    expect(canSubmit(r)).toBe(true)
  })

  it("sent back wins over everything and leaves the waiting list", () => {
    const r = done({ returned_at: "x", reviewed_at: "y", email_status: "sent" })
    expect(reviewState(r)).toBe("sent_back")
    expect(isWaitingForStaff(r)).toBe(false)
  })

  it("has a plain-words label for every state", () => {
    for (const s of ["needs_review", "ready", "sending", "send_failed", "sent", "sent_back"] as const) expect(REVIEW_STATE_TEXT[s].length).toBeGreaterThan(3)
    expect([...WAITING_STATES]).toEqual(["needs_review", "ready", "sending", "send_failed"])
  })
})

describe("what each button may do", () => {
  it("Reviewed only on an application nobody has looked at", () => {
    expect(canMarkReviewed(done())).toBe(true)
    expect(canMarkReviewed(done({ reviewed_at: "x" }))).toBe(false)
    expect(canMarkReviewed(done({ email_status: "sent" }))).toBe(false)
    expect(canMarkReviewed(done({ status: "opened" }))).toBe(false)
  })

  it("Submit needs Reviewed first", () => {
    expect(canSubmit(done())).toBe(false)
    expect(canSubmit(done({ reviewed_at: "x" }))).toBe(true)
    expect(canSubmit(done({ reviewed_at: "x", email_status: "sent" }))).toBe(false)
    expect(canSubmit(done({ reviewed_at: "x", returned_at: "y" }))).toBe(false)
  })

  it("Send back works before AND after submitting (the bank may ask for a correction later), but not twice and not mid-send", () => {
    expect(canSendBack(done())).toBe(true)
    expect(canSendBack(done({ reviewed_at: "x" }))).toBe(true)
    expect(canSendBack(done({ email_status: "sent" }))).toBe(true)
    expect(canSendBack(done({ returned_at: "x" }))).toBe(false)
    expect(canSendBack(done({ email_status: "sending" }))).toBe(false)
    expect(canSendBack(done({ status: "revoked" }))).toBe(false)
  })
})

describe("a send that never finished", () => {
  const now = Date.parse("2026-11-02T12:00:00Z")
  const sending = (ago: number, over: Record<string, unknown> = {}) => done({ reviewed_at: "x", email_status: "sending", updated_at: new Date(now - ago).toISOString(), ...over })

  it("is stale only after 5 minutes of 'sending'", () => {
    expect(isStaleSending(sending(60_000), now)).toBe(false)
    expect(isStaleSending(sending(STALE_SENDING_MS + 1000), now)).toBe(true)
    expect(isStaleSending(done({ reviewed_at: "x", email_status: "sent", updated_at: "2020-01-01T00:00:00Z" }), now)).toBe(false)
    expect(isStaleSending(done({ email_status: "sending" }), now)).toBe(false) // no timestamp: never guess
  })

  it("gives staff a way out (a deliberate Submit again), but not while it may still be running", () => {
    expect(canSubmit(sending(60_000), now)).toBe(false)
    expect(canSubmit(sending(STALE_SENDING_MS + 1000), now)).toBe(true)
  })
})

describe("an application whose OLD automatic send failed before reviews existed", () => {
  it("can be reviewed, and only then submitted (otherwise it would be a dead end)", () => {
    const legacy = done({ email_status: "failed" })
    expect(reviewState(legacy)).toBe("send_failed")
    expect(canSubmit(legacy)).toBe(false)
    expect(canMarkReviewed(legacy)).toBe(true)
    const reviewed = done({ email_status: "failed", reviewed_at: "x" })
    expect(canMarkReviewed(reviewed)).toBe(false)
    expect(canSubmit(reviewed)).toBe(true)
  })
})

describe("gmailRefusedTheSend — only a clear refusal proves nothing went out", () => {
  it("a 4xx answer from Gmail (too big, not authorised, bad address, rate limit) is a refusal", () => {
    for (const m of ["Gmail API 400: Request payload size exceeds the limit", "Gmail API 401: Invalid Credentials", "Gmail API 403: Forbidden", "Gmail API 413: Too large", "Gmail API 429: Rate limit exceeded"]) {
      expect(gmailRefusedTheSend(m)).toBe(true)
    }
  })

  it("a timeout, a server error, a dropped connection, a token problem or anything unrecognised is NOT a refusal (it stays 'not confirmed')", () => {
    for (const m of ["Gmail API 408: Request Timeout", "Gmail API 500: Backend Error", "Gmail API 503: Service Unavailable", "fetch failed", "Unexpected end of JSON input", "invalid_grant", "", "The email could not be sent."]) {
      expect(gmailRefusedTheSend(m)).toBe(false)
    }
  })

  it("only counts the Gmail wording at the START of the message", () => {
    expect(gmailRefusedTheSend("x Gmail API 400: nope")).toBe(false)
    expect(gmailRefusedTheSend("Gmail API 4000: nope")).toBe(false)
  })
})

describe("sendMayHaveGoneOut — when Submit again could email the passports twice", () => {
  const NOW = Date.parse("2026-11-03T12:00:00Z")
  const failed = (email_error: string | null) => done({ reviewed_at: "x", email_status: "failed", email_error })

  it("is true for a failure Gmail never confirmed (the error starts with the shared warning)", () => {
    expect(sendMayHaveGoneOut(failed(`${SEND_UNCONFIRMED_PREFIX}fetch failed`), NOW)).toBe(true)
  })

  it("is false for a failure that definitely did not go out (a plain error, or none)", () => {
    expect(sendMayHaveGoneOut(failed('Could not read the file "p.pdf" from storage.'), NOW)).toBe(false)
    expect(sendMayHaveGoneOut(failed(null), NOW)).toBe(false)
    expect(sendMayHaveGoneOut(failed(""), NOW)).toBe(false)
  })

  it("only matches the warning at the START of the error, not somewhere inside it", () => {
    expect(sendMayHaveGoneOut(failed(`x ${SEND_UNCONFIRMED_PREFIX}`), NOW)).toBe(false)
  })

  it("is true for a send that stalled for over 5 minutes, false for one that just started", () => {
    const stalled = done({ reviewed_at: "x", email_status: "sending", updated_at: new Date(NOW - STALE_SENDING_MS - 1000).toISOString() })
    const fresh = done({ reviewed_at: "x", email_status: "sending", updated_at: new Date(NOW - 30_000).toISOString() })
    expect(sendMayHaveGoneOut(stalled, NOW)).toBe(true)
    expect(sendMayHaveGoneOut(fresh, NOW)).toBe(false)
  })

  it("is false for anything that is not a failed or stalled send (never cries wolf)", () => {
    expect(sendMayHaveGoneOut(done(), NOW)).toBe(false)
    expect(sendMayHaveGoneOut(done({ reviewed_at: "x" }), NOW)).toBe(false)
    expect(sendMayHaveGoneOut(done({ reviewed_at: "x", email_status: "sent" }), NOW)).toBe(false)
    // a stale error text left on a row that is no longer 'failed' (e.g. it was claimed again) does not count
    expect(sendMayHaveGoneOut(done({ reviewed_at: "x", email_status: "sending", email_error: SEND_UNCONFIRMED_PREFIX, updated_at: new Date(NOW - 1000).toISOString() }), NOW)).toBe(false)
  })

  it("the Submit button stays available after an unconfirmed failure (the warning, not a block, is what protects it)", () => {
    expect(canSubmit(failed(`${SEND_UNCONFIRMED_PREFIX}timeout`))).toBe(true)
  })
})

describe("undo send back — when it is offered", () => {
  const sentBack = { status: "completed", email_status: "sent", reviewed_at: "x", returned_at: "2026-11-03T10:00:00Z" }

  it("is offered while the new link was never opened", () => {
    expect(canUndoSendBack(sentBack, [{ status: "pending" }])).toBe(true)
  })

  it("is offered when the new link was already revoked, or there is none", () => {
    expect(canUndoSendBack(sentBack, [{ status: "revoked" }])).toBe(true)
    expect(canUndoSendBack(sentBack, [])).toBe(true)
    expect(canUndoSendBack(sentBack, [{ status: "revoked" }, { status: "revoked" }])).toBe(true)
  })

  it("is NOT offered once the client opened the new link or sent a corrected application", () => {
    expect(canUndoSendBack(sentBack, [{ status: "opened" }])).toBe(false)
    expect(canUndoSendBack(sentBack, [{ status: "completed" }])).toBe(false)
  })

  it("is NOT offered when more than one link is waiting (should not happen; the database forbids it)", () => {
    expect(canUndoSendBack(sentBack, [{ status: "pending" }, { status: "pending" }])).toBe(false)
  })

  it("is NOT offered on an application that is not sent back", () => {
    expect(canUndoSendBack({ status: "completed", email_status: null, reviewed_at: "x", returned_at: null }, [])).toBe(false)
    expect(canUndoSendBack({ status: "opened", email_status: null, returned_at: null }, [])).toBe(false)
  })

  it("explains in words why it cannot be undone", () => {
    expect(undoSendBackBlock([{ status: "pending" }])).toBeNull()
    expect(undoSendBackBlock([{ status: "opened" }])).toMatch(/Revoke/)
    expect(undoSendBackBlock([{ status: "completed" }])).toMatch(/corrected application/)
  })
})
