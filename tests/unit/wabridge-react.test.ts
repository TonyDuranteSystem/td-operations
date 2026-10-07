import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import {
  PHONE_SAFE_EMOJI, isPhoneSafeEmoji, parseReactClaim, parseReactResult, parseQueueAnswer, describePhoneReactionRefusal,
  describePhoneReactionState, isPhoneReactionInFlight, reactBackoffSeconds, PHONE_REACTION_MAX_AGE_MS,
} from "@/lib/messaging/wabridge-react"

const now = new Date("2026-10-07T12:00:00Z")
const ID = "11111111-2222-4333-8444-555555555555"

describe("the safe emoji set", () => {
  it("is exactly the list inside the database function (compared against the migration file)", () => {
    const sql = readFileSync("scripts/migrations/20261007-1600-wabridge-crm-reactions-to-phone.sql", "utf8")
    const m = /ARRAY\[([^\]]+)\]\)\s*\n\$\$/.exec(sql) ?? /= ANY \(ARRAY\[([^\]]+)\]\)/.exec(sql)
    expect(m).not.toBeNull()
    const inSql = (m as RegExpExecArray)[1].split(",").map((x) => x.trim().replace(/^'|'$/g, ""))
    expect(inSql).toEqual([...PHONE_SAFE_EMOJI])
  })
  it("accepts the common reactions with or without the variation selector, and refuses anything else", () => {
    for (const e of ["👍", "❤️", "❤", "😂", "🙏", "🤝", "🔝", "✅"]) expect(isPhoneSafeEmoji(e)).toBe(true)
    for (const e of ["🧨", "", "abc", "👍👍", null, undefined, 5]) expect(isPhoneSafeEmoji(e)).toBe(false)
  })
  it("the message age limit is one hour (Antonio, 2026-10-07)", () => {
    expect(PHONE_REACTION_MAX_AGE_MS).toBe(3_600_000)
    const sql = readFileSync("scripts/migrations/20261007-1600-wabridge-crm-reactions-to-phone.sql", "utf8")
    expect(sql).toMatch(/m\.created_at < now\(\) - interval '1 hour'/)
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
  it("reads a result: success, failure with a reason, and refuses malformed ones", () => {
    expect(parseReactResult({ event: "bridge.react.result", ts: now.getTime(), id: ID, ok: true }, now)).toEqual({ ok: true, reason: null, id: ID, sent: true, error: null })
    const f = parseReactResult({ event: "bridge.react.result", ts: now.getTime(), id: ID, ok: false, error: "no" }, now)
    expect(f).toMatchObject({ ok: true, sent: false, error: "no" })
    expect(parseReactResult({ event: "bridge.react.result", ts: now.getTime(), id: ID, ok: false }, now)?.error).toBeTruthy()
    for (const bad of [{ id: "x", ok: true }, { id: ID }, { id: ID, ok: "yes" }, { id: ID, ok: true, ts: 1 }]) {
      expect(parseReactResult({ event: "bridge.react.result", ts: now.getTime(), ...bad }, now)?.ok).toBe(false)
    }
    expect(parseReactResult({ event: "other" }, now)).toBeNull()
  })
  it("truncates a very long error and never lets it through empty", () => {
    const r = parseReactResult({ event: "bridge.react.result", ts: now.getTime(), id: ID, ok: false, error: "x".repeat(900) }, now)
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
    for (const r of ["not_allowed", "too_old", "bad_emoji", "offline", "no_message_id", "not_one_to_one", "weird"]) {
      const t = describePhoneReactionRefusal(r)
      expect(t).toMatch(/^Saved in the CRM/)
      expect(t).not.toMatch(/undefined|null/)
    }
    expect(describePhoneReactionRefusal("too_old")).toMatch(/1 hour/)
  })
  it("the status line: pending / sending / failed / expired speak, sent / cancelled / nothing do not", () => {
    expect(describePhoneReactionState({ status: "pending", desired: "👍", error: null })?.text).toMatch(/click it again to undo/)
    expect(describePhoneReactionState({ status: "pending", desired: "", error: null })?.text).toMatch(/Removing/)
    expect(describePhoneReactionState({ status: "sending", desired: "👍", error: null })?.tone).toBe("neutral")
    const failed = describePhoneReactionState({ status: "failed", desired: "👍", error: "no answer" })
    expect(failed?.tone).toBe("bad")
    expect(failed?.text).toMatch(/no answer/)
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
  it("the Mac waits longer when the CRM says it is paused or capped, shorter when idle", () => {
    expect(reactBackoffSeconds("paused")).toBeGreaterThan(reactBackoffSeconds("nothing_to_send"))
    expect(reactBackoffSeconds("hourly_cap")).toBeGreaterThanOrEqual(30)
    expect(reactBackoffSeconds(undefined)).toBe(4)
  })
})
