import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import {
  PHONE_SAFE_EMOJI, parseReactClaim, parseReactResult, parseQueueAnswer, describePhoneReactionRefusal,
  describePhoneReactionState, isPhoneReactionInFlight,
} from "@/lib/messaging/wabridge-react"

const now = new Date("2026-10-07T12:00:00Z")
const ID = "11111111-2222-4333-8444-555555555555"
const SQL = readFileSync("scripts/migrations/20261007-1600-wabridge-crm-reactions-to-phone.sql", "utf8")

describe("the safe emoji set", () => {
  it("is exactly the list inside the database function (compared against the migration file)", () => {
    const m = /= ANY \(ARRAY\[([^\]]+)\]\)/.exec(SQL)
    expect(m).not.toBeNull()
    const inSql = (m as RegExpExecArray)[1].split(",").map((x) => x.trim().replace(/^'|'$/g, ""))
    expect(inSql).toEqual([...PHONE_SAFE_EMOJI])
  })
  it("the list shown to staff in the refusal text is built from it", () => {
    const t = describePhoneReactionRefusal("bad_emoji") as string
    for (const e of PHONE_SAFE_EMOJI) expect(t).toContain(e === "❤" ? "❤️" : e)
  })
  it("the age limit (1 hour) and the replies-only rule really are in the database function", () => {
    expect(SQL).toMatch(/p_action = 'set' AND m\.created_at < now\(\) - interval '1 hour'/)
    expect(SQL).toMatch(/x\.direction = 'inbound'/)
  })
})

describe("parseReactClaim / parseReactResult", () => {
  it("accepts a fresh claim, refuses a stale or unsigned-looking one, ignores other events", () => {
    expect(parseReactClaim({ event: "bridge.react.claim", ts: now.getTime() }, now)).toEqual({ ok: true, reason: null })
    expect(parseReactClaim({ event: "bridge.react.claim", ts: now.getTime() - 3_600_000 }, now)?.ok).toBe(false)
    expect(parseReactClaim({ event: "bridge.react.claim" }, now)?.ok).toBe(false)
    expect(parseReactClaim({ event: "bridge.send.claim", ts: now.getTime() }, now)).toBeNull()
    expect(parseReactClaim(null, now)).toBeNull()
  })
  it("reads a result: success, failure with a reason — each carries the claim number and the Mac's clock", () => {
    const ts = now.getTime()
    expect(parseReactResult({ event: "bridge.react.result", ts, id: ID, attempt: 2, ok: true }, now)).toEqual({ ok: true, reason: null, id: ID, attempt: 2, ts, sent: true, error: null })
    const f = parseReactResult({ event: "bridge.react.result", ts, id: ID, attempt: 1, ok: false, error: "no" }, now)
    expect(f).toMatchObject({ ok: true, sent: false, error: "no", attempt: 1 })
    expect(parseReactResult({ event: "bridge.react.result", ts, id: ID, attempt: 1, ok: false }, now)?.error).toBeTruthy()
  })
  it("refuses a malformed result — including a missing or silly claim number", () => {
    const ts = now.getTime()
    for (const bad of [{ id: "x", attempt: 1, ok: true }, { id: ID, attempt: 1 }, { id: ID, attempt: 1, ok: "yes" }, { id: ID, attempt: 1, ok: true, ts: 1 },
                       { id: ID, ok: true }, { id: ID, attempt: 0, ok: true }, { id: ID, attempt: 1.5, ok: true }, { id: ID, attempt: "1", ok: true }, { id: ID, attempt: 101, ok: true }]) {
      expect(parseReactResult({ event: "bridge.react.result", ts, ...bad }, now)?.ok).toBe(false)
    }
    expect(parseReactResult({ event: "other" }, now)).toBeNull()
  })
  it("truncates a very long error and never lets it through empty", () => {
    const r = parseReactResult({ event: "bridge.react.result", ts: now.getTime(), id: ID, attempt: 1, ok: false, error: "x".repeat(900) }, now)
    expect(r?.error?.length).toBe(300)
  })
})

describe("the queue answer and what staff are told", () => {
  it("reads the database answer and fails closed on anything odd", () => {
    expect(parseQueueAnswer({ ok: true, queued: true, id: ID, status: "pending", hold_seconds: 10 })).toEqual({ queued: true, reason: null, holdSeconds: 10 })
    expect(parseQueueAnswer({ ok: true, queued: false, reason: "too_old" })).toEqual({ queued: false, reason: "too_old", holdSeconds: 0 })
    expect(parseQueueAnswer({ ok: false, code: "not_found" })).toMatchObject({ queued: false, reason: "not_found" })
    for (const odd of [null, undefined, "x", 5, {}, { ok: true }]) expect(parseQueueAnswer(odd).queued).toBe(false)
  })
  it("says nothing when the feature is off or nothing changed; explains every real refusal in plain words", () => {
    expect(describePhoneReactionRefusal("off")).toBeNull()
    expect(describePhoneReactionRefusal("unchanged")).toBeNull()
    for (const r of ["not_allowed", "too_old", "bad_emoji", "offline", "sender_offline", "no_message_id", "no_inbound", "not_one_to_one", "weird"]) {
      const t = describePhoneReactionRefusal(r)
      expect(t).toMatch(/^Saved in the CRM/)
      expect(t).not.toMatch(/undefined|null/)
    }
    expect(describePhoneReactionRefusal("too_old")).toMatch(/1 hour/)
    expect(describePhoneReactionRefusal("no_inbound")).toMatch(/hasn't written/)
  })
  it("a refused REMOVAL is worded as a removal, not as a pick", () => {
    expect(describePhoneReactionRefusal("offline", "remove")).toMatch(/removal was not sent/)
    expect(describePhoneReactionRefusal("offline", "set")).toMatch(/^Saved in the CRM — not sent to the phone/)
    expect(describePhoneReactionRefusal("weird", "remove")).toMatch(/removal could not be sent/)
  })
  it("the status line: pending / sending / failed / expired speak, sent / cancelled / nothing do not", () => {
    expect(describePhoneReactionState({ status: "pending", desired: "👍", error: null })?.text).toMatch(/click it again to undo/)
    expect(describePhoneReactionState({ status: "pending", desired: "", error: null })?.text).toMatch(/Removing/)
    expect(describePhoneReactionState({ status: "sending", desired: "👍", error: null })?.tone).toBe("neutral")
    const failed = describePhoneReactionState({ status: "failed", desired: "👍", error: "no answer" })
    expect(failed?.tone).toBe("bad")
    expect(failed?.text).toMatch(/no answer/)
    expect(failed?.text).toMatch(/click the emoji twice/) // a click on a picked emoji removes the team mark first, so a retry is two clicks
    expect(describePhoneReactionState({ status: "expired", desired: "👍", error: null })?.tone).toBe("bad")
    for (const s of ["sent", "cancelled", "weird"]) expect(describePhoneReactionState({ status: s, desired: "👍", error: null })).toBeNull()
    expect(describePhoneReactionState(null)).toBeNull()
    expect(describePhoneReactionState(undefined)).toBeNull()
  })
  it("only pending / sending count as in flight (drives the faster refresh)", () => {
    expect(isPhoneReactionInFlight("pending")).toBe(true)
    expect(isPhoneReactionInFlight("sending")).toBe(true)
    for (const s of ["sent", "failed", "expired", "cancelled", null, undefined]) expect(isPhoneReactionInFlight(s as string | null | undefined)).toBe(false)
  })
})
