import { describe, it, expect } from "vitest"
import { stripPerTurnAssertions, REPLAY_TURNS, REPLAY_CHAR_BUDGET } from "@/lib/ai-agent/thread-context"

/**
 * The replay turns stored turns back into real user/assistant messages. Two rules
 * carry the weight, and both are here:
 *
 *  1. Only COMPLETE pairs. A turn killed mid-flight has a question and no answer;
 *     replaying it yields two consecutive user turns, which the API rejects — and
 *     because the row never gets an answer, that conversation would break for every
 *     later message, permanently. (The pair rule lives in the DB query + loop in
 *     buildReplayTurns; exercised end-to-end on sandbox.)
 *  2. Per-turn server assertions must NOT be replayed. They are statements about the
 *     turn that produced them — which addresses may be emailed, which uploads are
 *     attachable, that an image is on screen. A turn later they are simply false.
 */
describe("stripPerTurnAssertions", () => {
  it("removes the email allow-list, which is only true for the turn that built it", () => {
    const out = stripPerTurnAssertions('Draft a reply.\n\n[EMAIL RULE — server-enforced: you may only email: a@x.com, b@y.com]')
    expect(out).toContain("Draft a reply.")
    expect(out).not.toMatch(/EMAIL RULE/)
    expect(out).not.toMatch(/a@x\.com/)
  })

  it("removes the attachable-files list, whose refs point at a different turn's uploads", () => {
    const out = stripPerTurnAssertions('Send it.\n\n[FILES YOU CAN ATTACH to an email on this turn (use send_email\'s `attach` with the ref): up1 — invoice.pdf]')
    expect(out).toBe("Send it.")
  })

  it("rewrites an image note to the PAST tense instead of deleting it", () => {
    // Deleting it loses that a file was discussed; keeping it as-is tells the model
    // an image is in front of it when the bytes are not replayed — the phantom-file
    // failure class. Past tense is the only honest option.
    const out = stripPerTurnAssertions('What is wrong here?\n\n[Attached image "wise-receipt.png" — shown to you above.]')
    expect(out).toContain("wise-receipt.png")
    expect(out).not.toMatch(/shown to you above/)
    expect(out).toMatch(/NOT attached now/)
  })

  it("rewrites a read-file note the same way", () => {
    const out = stripPerTurnAssertions('[Attached file "bank.csv" — extracted text follows.]')
    expect(out).toMatch(/was read on that earlier turn/)
    expect(out).not.toMatch(/extracted text follows/)
  })

  it("removes the media-dropped note", () => {
    expect(stripPerTurnAssertions('Hi\n\n[Not attached: an image (too much attached at once).]')).toBe("Hi")
  })

  it("leaves an ordinary message completely untouched", () => {
    const plain = "Can you shorten the draft you just wrote?"
    expect(stripPerTurnAssertions(plain)).toBe(plain)
  })

  it("survives empty and missing input", () => {
    expect(stripPerTurnAssertions("")).toBe("")
    expect(stripPerTurnAssertions(undefined as unknown as string)).toBe("")
  })
})

describe("replay dials", () => {
  it("keeps the window small — every replayed character is re-sent on each tool-loop iteration", () => {
    expect(REPLAY_TURNS).toBeGreaterThan(0)
    expect(REPLAY_TURNS).toBeLessThanOrEqual(6)
    expect(REPLAY_CHAR_BUDGET).toBeLessThanOrEqual(60_000)
  })
})
