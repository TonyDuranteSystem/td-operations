import { describe, it, expect } from "vitest"
import {
  OUTBOX_TEAM_LABEL,
  describeOutboxStatus,
  isOutboxPending,
  normalizeSendMode,
  parseEnqueueResult,
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
  it("only a queued message is pending", () => {
    expect(isOutboxPending("queued")).toBe(true)
    for (const s of ["shadow", "sent", "failed", "unknown"]) expect(isOutboxPending(s)).toBe(false)
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
