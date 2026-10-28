import { describe, it, expect } from "vitest"
import {
  normalizeCommands, parseRecoverResult, recoverView, describeRecoverDone, codeRequestView, NO_COMMANDS,
  RECOVER_WAIT_MS, RECOVER_RESULT_SHOW_MS,
} from "@/lib/messaging/wabridge-commands"

const NOW = new Date("2026-10-28T18:00:00Z")
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

describe("normalizeCommands", () => {
  it("passes a well-formed answer through", () => {
    expect(normalizeCommands({ want_code: true, recover_days: 7 })).toEqual({ want_code: true, recover_days: 7 })
    expect(normalizeCommands({ want_code: false, recover_days: null })).toEqual(NO_COMMANDS)
  })
  it("treats anything unexpected as nothing to do — a bad reply must never start work on the Mac", () => {
    expect(normalizeCommands(null)).toEqual(NO_COMMANDS)
    expect(normalizeCommands("x")).toEqual(NO_COMMANDS)
    expect(normalizeCommands({ want_code: "true", recover_days: 7 })).toEqual({ want_code: false, recover_days: 7 })
    expect(normalizeCommands({ want_code: false, recover_days: 0 }).recover_days).toBeNull()
    expect(normalizeCommands({ want_code: false, recover_days: 400 }).recover_days).toBeNull()
    expect(normalizeCommands({ want_code: false, recover_days: 2.5 }).recover_days).toBeNull()
  })
})

describe("parseRecoverResult", () => {
  const ok = (extra: Record<string, unknown> = {}) => ({ event: "bridge.recover.result", ts: NOW.getTime(), saved: 1, read: 26, ...extra })
  it("accepts a fresh, sane report", () => {
    expect(parseRecoverResult(ok(), NOW)).toEqual({ ok: true, saved: 1, read: 26 })
    expect(parseRecoverResult(ok({ saved: 0, read: 0 }), NOW)).toEqual({ ok: true, saved: 0, read: 0 })
  })
  it("ignores other events", () => {
    expect(parseRecoverResult({ event: "bridge.heartbeat" }, NOW)).toBeNull()
    expect(parseRecoverResult(null, NOW)).toBeNull()
  })
  it("rejects a stale or missing timestamp (no replays)", () => {
    expect(parseRecoverResult(ok({ ts: NOW.getTime() - 10 * 60_000 }), NOW)).toMatchObject({ ok: false })
    expect(parseRecoverResult({ event: "bridge.recover.result", saved: 1, read: 2 }, NOW)).toMatchObject({ ok: false })
  })
  it("rejects bad counts", () => {
    for (const bad of [{ saved: -1 }, { read: 1.5 }, { saved: "1" }, { read: 1_000_000 }, { saved: 30, read: 26 }]) {
      expect(parseRecoverResult(ok(bad), NOW)).toMatchObject({ ok: false })
    }
  })
})

describe("recoverView", () => {
  it("is idle with nothing requested", () => {
    expect(recoverView(null, NOW)).toEqual({ state: "idle" })
    expect(recoverView({}, NOW)).toEqual({ state: "idle" })
    expect(recoverView({ recover_requested_at: "garbage" }, NOW)).toEqual({ state: "idle" })
  })
  it("waiting until the Mac picks it up, then running", () => {
    expect(recoverView({ recover_requested_at: ago(20_000) }, NOW)).toEqual({ state: "waiting" })
    expect(recoverView({ recover_requested_at: ago(40_000), recover_started_at: ago(20_000) }, NOW)).toEqual({ state: "running" })
  })
  it("says no_answer when the Mac never reports back within the wait", () => {
    expect(recoverView({ recover_requested_at: ago(RECOVER_WAIT_MS + 1000) }, NOW)).toEqual({ state: "no_answer" })
    expect(recoverView({ recover_requested_at: ago(RECOVER_WAIT_MS + 1000), recover_started_at: ago(RECOVER_WAIT_MS) }, NOW)).toEqual({ state: "no_answer" })
  })
  it("shows the result for a while, then goes back to idle", () => {
    const f = { recover_requested_at: ago(60_000), recover_done_at: ago(30_000), recover_saved: 1, recover_read: 26 }
    expect(recoverView(f, NOW)).toEqual({ state: "done", saved: 1, read: 26, at: f.recover_done_at })
    expect(recoverView({ ...f, recover_done_at: ago(RECOVER_RESULT_SHOW_MS + 1000) }, NOW)).toEqual({ state: "idle" })
  })
})

describe("describeRecoverDone", () => {
  it("uses plain words", () => {
    expect(describeRecoverDone(1, 26)).toBe("1 missing message recovered.")
    expect(describeRecoverDone(3, 26)).toBe("3 missing messages recovered.")
    expect(describeRecoverDone(0, 26)).toMatch(/Nothing missing/)
    expect(describeRecoverDone(0, 0)).toMatch(/history is empty/)
  })
})

describe("codeRequestView", () => {
  it("is requested only while the request is under 5 minutes old", () => {
    expect(codeRequestView({ link_code_wanted_at: ago(60_000) }, NOW).requested).toBe(true)
    expect(codeRequestView({ link_code_wanted_at: ago(6 * 60_000) }, NOW).requested).toBe(false)
    expect(codeRequestView(null, NOW).requested).toBe(false)
  })
  it("reports the hour limit only when 5 codes were made inside the hour", () => {
    expect(codeRequestView({ link_attempts: 5, link_window_at: ago(10 * 60_000) }, NOW).limitUntil).toBe(new Date(NOW.getTime() - 10 * 60_000 + 3_600_000).toISOString())
    expect(codeRequestView({ link_attempts: 4, link_window_at: ago(10 * 60_000) }, NOW).limitUntil).toBeNull()
    expect(codeRequestView({ link_attempts: 5, link_window_at: ago(61 * 60_000) }, NOW).limitUntil).toBeNull()
  })
})
