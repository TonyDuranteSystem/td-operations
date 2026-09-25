import { describe, it, expect } from "vitest"
import {
  OUTBOX_TEAM_LABEL,
  SENDING_WINDOW_MS,
  claimBackoffSeconds,
  describeOutboxStatus,
  isOutboxPending,
  normalizeSendMode,
  parseAllowlistInput,
  outboxDisplayStatus,
  parseEnqueueResult,
  parseSendClaim,
  parseSendResult,
  refusalHttpStatus,
  sendNotice,
} from "@/lib/messaging/wabridge-outbox"

describe("parseEnqueueResult — always fails closed", () => {
  it("reads a queued/shadow answer, with the duplicate flag", () => {
    expect(parseEnqueueResult({ ok: true, id: "abc", status: "shadow" })).toEqual({ ok: true, id: "abc", status: "shadow", duplicate: false })
    expect(parseEnqueueResult({ ok: true, id: "abc", status: "queued", duplicate: true })).toEqual({ ok: true, id: "abc", status: "queued", duplicate: true })
  })
  it("reads a refusal", () => {
    expect(parseEnqueueResult({ ok: false, code: "paused", message: "Paused." })).toEqual({ ok: false, code: "paused", message: "Paused." })
  })
  it("treats anything unreadable as a refusal, never as queued", () => {
    for (const bad of [null, undefined, "ok", 42, [], {}, { ok: true }, { ok: true, id: 1, status: "queued" }, { ok: true, id: "a", status: "flying" }, { ok: false }, { ok: "true", id: "a", status: "queued" }]) {
      const r = parseEnqueueResult(bad)
      expect(r.ok).toBe(false)
      if (r.ok === false) expect(r.message.length).toBeGreaterThan(10)
    }
  })
})

describe("refusalHttpStatus", () => {
  it("maps rule refusals to 409, bad input to 400, missing to 404, unknown to 500", () => {
    for (const c of ["paused", "no_inbound", "not_allowed", "inactive", "not_one_to_one", "not_wabridge"]) expect(refusalHttpStatus(c)).toBe(409)
    for (const c of ["empty", "too_long", "bad_request"]) expect(refusalHttpStatus(c)).toBe(400)
    expect(refusalHttpStatus("not_found")).toBe(404)
    expect(refusalHttpStatus("something_new")).toBe(500)
    expect(refusalHttpStatus("unreadable")).toBe(500)
  })
})

describe("status wording", () => {
  it("has wording for every state that needs a pill, and none for sent", () => {
    expect(describeOutboxStatus("shadow")?.label).toMatch(/NOT sent/)
    expect(describeOutboxStatus("queued")?.label).toMatch(/Waiting/)
    expect(describeOutboxStatus("unknown")?.label).toMatch(/check the phone/i)
    expect(describeOutboxStatus("failed")?.tone).toBe("bad")
    expect(describeOutboxStatus("sent")).toBeNull()
    expect(describeOutboxStatus("nonsense")).toBeNull()
  })
  it("a message waiting or being sent is pending; nothing else is", () => {
    expect(isOutboxPending("queued")).toBe(true)
    expect(isOutboxPending("sending")).toBe(true)
    for (const s of ["shadow", "sent", "failed", "unknown"]) expect(isOutboxPending(s)).toBe(false)
  })
  it("has wording for the sending state", () => {
    expect(describeOutboxStatus("sending")?.label).toMatch(/Sending/)
  })
  it("every CRM reply is labelled TD Team (no personal names)", () => {
    expect(OUTBOX_TEAM_LABEL).toBe("TD Team")
  })
})

describe("send mode + notice", () => {
  it("anything that is not exactly shadow or live is paused (fail closed)", () => {
    expect(normalizeSendMode("shadow")).toBe("shadow")
    expect(normalizeSendMode("live")).toBe("live")
    for (const v of ["paused", "", "LIVE", null, undefined, 1, {}]) expect(normalizeSendMode(v)).toBe("paused")
  })
  it("paused wins over everything; then no-inbound; then test mode; live with a recent conversation shows nothing", () => {
    expect(sendNotice({ mode: "paused", hasInbound: true })?.text).toMatch(/paused/)
    expect(sendNotice({ mode: "paused", hasInbound: false })?.text).toMatch(/paused/)
    expect(sendNotice({ mode: "shadow", hasInbound: false })?.text).toMatch(/only reply to people who have written/)
    expect(sendNotice({ mode: "live", hasInbound: false })?.text).toMatch(/only reply to people who have written/)
    expect(sendNotice({ mode: "shadow", hasInbound: true })?.text).toMatch(/NOT sent/)
    expect(sendNotice({ mode: "live", hasInbound: true })).toBeNull()
  })
})


const NOW = new Date("2026-09-25T18:00:00Z")
const OB = "9c1a2b3c-0000-4000-8000-0000000000aa"

describe("outboxDisplayStatus", () => {
  it("a claimed message is 'sending' for under 2 minutes, then 'unknown' (needs a person)", () => {
    const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString()
    expect(outboxDisplayStatus("unknown", at(10_000), NOW)).toBe("sending")
    expect(outboxDisplayStatus("unknown", at(SENDING_WINDOW_MS - 1), NOW)).toBe("sending")
    expect(outboxDisplayStatus("unknown", at(SENDING_WINDOW_MS), NOW)).toBe("unknown")
    expect(outboxDisplayStatus("unknown", at(60 * 60_000), NOW)).toBe("unknown")
  })
  it("garbage or missing claim time never shows a false 'sending'", () => {
    expect(outboxDisplayStatus("unknown", null, NOW)).toBe("unknown")
    expect(outboxDisplayStatus("unknown", undefined, NOW)).toBe("unknown")
    expect(outboxDisplayStatus("unknown", "garbage", NOW)).toBe("unknown")
    expect(outboxDisplayStatus("unknown", new Date(NOW.getTime() + 60_000).toISOString(), NOW)).toBe("unknown")
  })
  it("every other status is passed through unchanged", () => {
    for (const st of ["shadow", "queued", "sent", "failed"]) expect(outboxDisplayStatus(st, new Date(NOW.getTime() - 1000).toISOString(), NOW)).toBe(st)
  })
})

describe("parseSendClaim", () => {
  it("accepts a fresh signed claim", () => {
    expect(parseSendClaim({ event: "bridge.send.claim", ts: NOW.getTime() }, NOW)).toEqual({ ok: true })
  })
  it("is not a claim → null; stale or missing timestamp → refused", () => {
    expect(parseSendClaim(null, NOW)).toBeNull()
    expect(parseSendClaim({ event: "bridge.heartbeat" }, NOW)).toBeNull()
    expect(parseSendClaim({ event: "bridge.send.claim", ts: NOW.getTime() - 5 * 60_000 }, NOW)).toEqual({ ok: false, reason: "stale or missing timestamp" })
    expect(parseSendClaim({ event: "bridge.send.claim" }, NOW)).toEqual({ ok: false, reason: "stale or missing timestamp" })
  })
})

describe("parseSendResult", () => {
  const ok = (over: Record<string, unknown> = {}) => ({ event: "bridge.send.result", ts: NOW.getTime(), outbox_id: OB, ok: true, message_id: "3EB0ABCDEF123456", ...over })
  it("a sent message needs its real message id, which is trimmed", () => {
    expect(parseSendResult(ok({ message_id: "  3EB0ABCDEF123456 " }), NOW)).toEqual({ ok: true, outboxId: OB, sent: true, messageId: "3EB0ABCDEF123456", error: null })
    for (const message_id of [undefined, "", "abc", 12345678, "x".repeat(201)]) {
      expect(parseSendResult(ok({ message_id }), NOW)).toEqual({ ok: false, reason: "a sent message needs its message id" })
    }
  })
  it("a failed send carries the program's error, capped, with a default", () => {
    expect(parseSendResult({ event: "bridge.send.result", ts: NOW.getTime(), outbox_id: OB, ok: false, error: "no LID found" }, NOW)).toEqual({ ok: true, outboxId: OB, sent: false, messageId: null, error: "no LID found" })
    const r = parseSendResult({ event: "bridge.send.result", ts: NOW.getTime(), outbox_id: OB, ok: false }, NOW)
    expect(r).toMatchObject({ ok: true, sent: false, error: "send failed" })
    const long = parseSendResult({ event: "bridge.send.result", ts: NOW.getTime(), outbox_id: OB, ok: false, error: "e".repeat(900) }, NOW)
    expect(long && long.ok && long.error?.length).toBe(500)
  })
  it("rejects a bad outbox id, a non-boolean ok, a stale timestamp; ignores other events", () => {
    expect(parseSendResult(ok({ outbox_id: "not-a-uuid" }), NOW)).toEqual({ ok: false, reason: "bad outbox id" })
    expect(parseSendResult(ok({ outbox_id: undefined }), NOW)).toEqual({ ok: false, reason: "bad outbox id" })
    expect(parseSendResult(ok({ ok: "true" }), NOW)).toEqual({ ok: false, reason: "ok must be a boolean" })
    expect(parseSendResult(ok({ ts: NOW.getTime() - 10 * 60_000 }), NOW)).toEqual({ ok: false, reason: "stale or missing timestamp" })
    expect(parseSendResult({ event: "bridge.send.claim" }, NOW)).toBeNull()
    expect(parseSendResult("x", NOW)).toBeNull()
  })
})

describe("claimBackoffSeconds", () => {
  it("waits longer when nothing can happen soon, shortly when it might", () => {
    expect(claimBackoffSeconds("paused")).toBe(30)
    expect(claimBackoffSeconds("unhealthy")).toBe(30)
    for (const r of ["hourly_cap", "daily_cap", "held"]) expect(claimBackoffSeconds(r)).toBe(60)
    for (const r of ["gap", "in_flight", "nothing_to_send", undefined, "something_new"]) expect(claimBackoffSeconds(r as string | undefined)).toBe(5)
  })
})

describe("parseAllowlistInput (the approved-numbers box)", () => {
  it("keeps numbers typed with spaces, plus signs, brackets and dashes as ONE number each", () => {
    expect(parseAllowlistInput("+1 727 423 4285")).toEqual(["17274234285"])
    expect(parseAllowlistInput("(727) 423-4285")).toEqual(["7274234285"])
    expect(parseAllowlistInput("+1 727 423 4285, +1 727 452 1093")).toEqual(["17274234285", "17274521093"])
  })
  it("splits on commas, semicolons and new lines only", () => {
    expect(parseAllowlistInput("17274234285;17274521093\n393331234567")).toEqual(["17274234285", "17274521093", "393331234567"])
  })
  it("drops junk (too short / too long / no digits) and duplicates", () => {
    expect(parseAllowlistInput("12, abc, 17274234285, 17274234285, +1 727 423 4285, 1234567890123456")).toEqual(["17274234285"])
    expect(parseAllowlistInput("")).toEqual([])
    expect(parseAllowlistInput("   ,, ;; ")).toEqual([])
  })
})
