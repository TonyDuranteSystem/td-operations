import { describe, it, expect } from "vitest"
import { REVIEW_STATE_TEXT, STALE_SENDING_MS, WAITING_STATES, canMarkReviewed, canSendBack, canSubmit, isStaleSending, isWaitingForStaff, reviewState } from "@/lib/bofa-intake/review-state"

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
