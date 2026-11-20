import { describe, it, expect } from "vitest"
import { isoWeekKey, parseVoiceCheck, decideVoiceCheckSend, voiceCheckView, applyAnswer, type VoiceCheck } from "@/lib/messaging/wabridge-voice-check"
import { attentionSummary } from "@/lib/messaging/wabridge-attention"

const MON = new Date("2026-11-16T14:00:00Z") // ISO week 47 of 2026
const sent = (over: Partial<VoiceCheck> = {}): VoiceCheck => ({ week: "2026-W47", status: "sent", sent_at: "2026-11-16T14:00:00.000Z", ...over })

describe("isoWeekKey", () => {
  it("uses ISO weeks (Monday start, Thursday decides the year)", () => {
    expect(isoWeekKey(new Date("2026-11-16T00:00:00Z"))).toBe("2026-W47")
    expect(isoWeekKey(new Date("2026-11-22T23:59:00Z"))).toBe("2026-W47") // Sunday still the same week
    expect(isoWeekKey(new Date("2026-11-23T00:00:00Z"))).toBe("2026-W48")
    expect(isoWeekKey(new Date("2027-01-01T12:00:00Z"))).toBe("2026-W53") // 1 Jan 2027 belongs to the last week of 2026
    expect(isoWeekKey(new Date("2025-12-29T12:00:00Z"))).toBe("2026-W01") // 29 Dec 2025 belongs to week 1 of 2026
  })
})

describe("parseVoiceCheck", () => {
  it("accepts a well-formed record and refuses junk", () => {
    expect(parseVoiceCheck(sent({ client_msg_id: "abc" }))).toMatchObject({ week: "2026-W47", status: "sent", client_msg_id: "abc" })
    for (const bad of [null, undefined, "x", 5, [], {}, { week: "w", status: "weird", sent_at: "t" }, { status: "sent" }]) expect(parseVoiceCheck(bad)).toBeNull()
  })
})

describe("decideVoiceCheckSend", () => {
  const base = { testChatId: "chat-1", health: "ok", sendMode: "live", current: null as VoiceCheck | null, now: MON }
  it("sends once a week when the feature is on, the line healthy and sending live", () => {
    expect(decideVoiceCheckSend(base)).toEqual({ send: true, reason: "due" })
    expect(decideVoiceCheckSend({ ...base, current: sent() }).reason).toBe("already_this_week")
    expect(decideVoiceCheckSend({ ...base, current: sent({ week: "2026-W46" }) }).send).toBe(true)
  })
  it("does nothing when off, offline or paused", () => {
    expect(decideVoiceCheckSend({ ...base, testChatId: null }).reason).toBe("off")
    expect(decideVoiceCheckSend({ ...base, health: "offline" }).reason).toBe("bridge_not_healthy")
    expect(decideVoiceCheckSend({ ...base, sendMode: "paused" }).reason).toBe("sending_not_live")
  })
})

describe("voiceCheckView", () => {
  const at = (min: number) => new Date(Date.parse("2026-11-16T14:00:00Z") + min * 60_000)
  it("waits a moment for the recording to arrive, then asks; reminds after a day", () => {
    expect(voiceCheckView(sent(), at(1))).toBeNull()
    const ask = voiceCheckView(sent(), at(5))
    expect(ask).toMatchObject({ level: "ask", actions: ["played", "not_played"] })
    expect(voiceCheckView(sent(), at(25 * 60))).toMatchObject({ level: "warning", actions: ["played", "not_played"] })
  })
  it("a Yes says nothing; a No is a red problem with a way to test again; a failed send is a warning", () => {
    expect(voiceCheckView(sent({ status: "played" }), at(60))).toBeNull()
    expect(voiceCheckView(sent({ status: "not_played" }), at(60))).toMatchObject({ level: "problem", actions: ["resend"] })
    const f = voiceCheckView(sent({ status: "send_failed", error: "Sending from the CRM is paused." }), at(60))
    expect(f).toMatchObject({ level: "warning", actions: ["resend"] })
    expect(f?.text).toContain("paused")
  })
  it("switched on but nothing sent this week: a quiet row offers 'Send a test now'; off, or already sent this week: nothing", () => {
    expect(voiceCheckView(null, MON, true)).toMatchObject({ level: "info", actions: ["resend"] })
    expect(voiceCheckView(sent({ week: "2026-W46", status: "played" }), MON, true)).toMatchObject({ level: "info" })
    expect(voiceCheckView(null, MON, false)).toBeNull()
    expect(voiceCheckView(sent({ status: "played" }), MON, true)).toBeNull() // this week's test was answered
    expect(voiceCheckView(sent(), at(5), true)?.level).toBe("ask")
    expect(voiceCheckView(sent({ week: "2026-W46", status: "not_played" }), MON, true)?.level).toBe("problem") // an old No still shows
  })
  it("no record, or a bad time, says nothing", () => {
    expect(voiceCheckView(null, MON)).toBeNull()
    expect(voiceCheckView(sent({ sent_at: "nope" }), MON)).toBeNull()
  })
})

describe("applyAnswer", () => {
  it("answers only a waiting test, once", () => {
    const a = applyAnswer(sent(), "played", MON)
    expect(a).toMatchObject({ status: "played", answered_at: MON.toISOString() })
    expect(applyAnswer(a, "not_played", MON)).toBeNull() // already answered
    expect(applyAnswer(null, "played", MON)).toBeNull()
    expect(applyAnswer(sent({ status: "send_failed" }), "played", MON)).toBeNull()
  })
})

describe("attentionSummary (the red dot)", () => {
  const ok = { health: "ok", problemText: null, update: null, voiceCheck: null }
  it("nothing to say when all is well, or the line is simply not monitored", () => {
    expect(attentionSummary(ok)).toBeNull()
    expect(attentionSummary({ ...ok, health: "unmonitored" })).toBeNull()
    expect(attentionSummary({ ...ok, health: "none" })).toBeNull()
  })
  it("a down link is always red and wins over everything", () => {
    const r = attentionSummary({ ...ok, health: "offline", problemText: "The bridge stopped reporting.", update: { level: "warning", title: "u", text: "t" } })
    expect(r).toEqual({ level: "problem", text: "The bridge stopped reporting." })
    expect(attentionSummary({ ...ok, health: "unlinked" })?.level).toBe("problem")
  })
  it("a bad update or a failed voice test is red; softer ones are amber; the worst wins", () => {
    expect(attentionSummary({ ...ok, update: { level: "problem", title: "Update broke", text: "" } })).toEqual({ level: "problem", text: "Update broke" })
    expect(attentionSummary({ ...ok, voiceCheck: { level: "problem", title: "Voice notes may not be playing" } })?.level).toBe("problem")
    expect(attentionSummary({ ...ok, voiceCheck: { level: "info", title: "Weekly voice-note test is on" } })).toBeNull() // the quiet row is not an alarm
    expect(attentionSummary({ ...ok, voiceCheck: { level: "ask", title: "Weekly voice-note test" } })).toEqual({ level: "warning", text: "Weekly voice-note test" })
    expect(attentionSummary({ ...ok, update: { level: "warning", title: "Update stopped", text: "" }, voiceCheck: { level: "ask", title: "v" } })?.text).toBe("Update stopped")
  })
})
