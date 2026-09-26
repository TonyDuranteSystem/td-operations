import { describe, it, expect } from "vitest"
import {
  voicePath,
  parseMediaClaim,
  parseMediaResult,
  sanitizeTranscript,
  describeVoiceState,
  isMediaPending,
  MAX_AUDIO_BYTES,
  MAX_TRANSCRIPT_CHARS,
} from "@/lib/messaging/wabridge-media"

const NOW = new Date("2026-09-26T12:00:00Z")
const ts = NOW.getTime()
const MID = "8f14e45f-ceea-467a-9575-4f0b0c1d2e3f"

describe("voicePath", () => {
  it("is server-built from the two ids", () => {
    expect(voicePath("c1", "m1")).toBe("voice/c1/m1.m4a")
  })
})

describe("parseMediaClaim", () => {
  it("accepts a fresh claim", () => expect(parseMediaClaim({ event: "bridge.media.claim", ts }, NOW)).toEqual({ ok: true }))
  it("rejects a stale one", () => expect(parseMediaClaim({ event: "bridge.media.claim", ts: ts - 10 * 60_000 }, NOW)).toMatchObject({ ok: false }))
  it("ignores other events and junk", () => {
    expect(parseMediaClaim({ event: "message", ts }, NOW)).toBeNull()
    expect(parseMediaClaim(null, NOW)).toBeNull()
    expect(parseMediaClaim("x", NOW)).toBeNull()
  })
})

describe("parseMediaResult", () => {
  const ready = { event: "bridge.media.result", ts, message_id: MID, outcome: "ready", size_bytes: 1234, duration_seconds: 19.4, transcript: "  ciao  ", language: "it", model: "whisper" }
  it("accepts a ready result and cleans it", () => {
    expect(parseMediaResult(ready, NOW)).toEqual({
      ok: true, messageId: MID, outcome: "ready", sizeBytes: 1234, durationSeconds: 19, transcript: "ciao", language: "it", model: "whisper", error: null,
    })
  })
  it("ready needs a sane size", () => {
    expect(parseMediaResult({ ...ready, size_bytes: 0 }, NOW)).toMatchObject({ ok: false })
    expect(parseMediaResult({ ...ready, size_bytes: MAX_AUDIO_BYTES + 1 }, NOW)).toMatchObject({ ok: false })
    expect(parseMediaResult({ ...ready, size_bytes: 1.5 }, NOW)).toMatchObject({ ok: false })
    expect(parseMediaResult({ ...ready, size_bytes: undefined }, NOW)).toMatchObject({ ok: false })
  })
  it("rejects bad ids, outcomes, stale timestamps", () => {
    expect(parseMediaResult({ ...ready, message_id: "nope" }, NOW)).toMatchObject({ ok: false })
    expect(parseMediaResult({ ...ready, outcome: "done" }, NOW)).toMatchObject({ ok: false })
    expect(parseMediaResult({ ...ready, ts: ts - 3_600_000 }, NOW)).toMatchObject({ ok: false })
    expect(parseMediaResult({ event: "x" }, NOW)).toBeNull()
  })
  it("expired/failed carry no audio fields", () => {
    expect(parseMediaResult({ event: "bridge.media.result", ts, message_id: MID, outcome: "expired", error: "410" }, NOW)).toEqual({
      ok: true, messageId: MID, outcome: "expired", sizeBytes: null, durationSeconds: null, transcript: null, language: null, model: null, error: "410",
    })
    const f = parseMediaResult({ event: "bridge.media.result", ts, message_id: MID, outcome: "failed", transcript: "ignored" }, NOW)
    expect(f).toMatchObject({ ok: true, outcome: "failed", transcript: null })
  })
  it("an empty transcript (silence) is still a ready note", () => {
    expect(parseMediaResult({ ...ready, transcript: "   " }, NOW)).toMatchObject({ ok: true, transcript: null })
  })
})

describe("sanitizeTranscript", () => {
  it("strips NULs/control chars, keeps newlines", () => expect(sanitizeTranscript("a\u0000b\u0007c\nd")).toBe("abc\nd"))
  it("caps the length", () => expect(sanitizeTranscript("x".repeat(MAX_TRANSCRIPT_CHARS + 50))).toHaveLength(MAX_TRANSCRIPT_CHARS))
  it("non-strings and blanks become null", () => {
    expect(sanitizeTranscript(5)).toBeNull()
    expect(sanitizeTranscript("  \n ")).toBeNull()
  })
})

describe("describeVoiceState", () => {
  const base = { transcript: null, durationSeconds: null, audioDeleted: false }
  it("ready is playable", () => expect(describeVoiceState({ ...base, status: "ready" })).toMatchObject({ playable: true, note: null }))
  it("a deleted file is never playable, even if status says ready", () => {
    const s = describeVoiceState({ ...base, status: "ready", audioDeleted: true })
    expect(s.playable).toBe(false)
    expect(s.note).toContain("transcript kept")
  })
  it("expired / failed / pending wording", () => {
    expect(describeVoiceState({ ...base, status: "expired" }).note).toContain("no longer available")
    expect(describeVoiceState({ ...base, status: "failed" }).tone).toBe("warn")
    expect(describeVoiceState({ ...base, status: "processing" }).note).toContain("Preparing")
    expect(describeVoiceState({ ...base, status: "none" }).playable).toBe(false)
  })
})

describe("isMediaPending", () => {
  it("pending only while it can still change", () => {
    expect(isMediaPending("waiting", false)).toBe(true)
    expect(isMediaPending("none", false)).toBe(true)
    expect(isMediaPending("ready", false)).toBe(false)
    expect(isMediaPending("expired", false)).toBe(false)
    expect(isMediaPending("waiting", true)).toBe(false)
  })
})
