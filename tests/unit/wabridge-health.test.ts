import { describe, it, expect } from "vitest"
import {
  classifyBridge,
  decideBridgeAlert,
  parseHeartbeat,
  HEARTBEAT_STALE_MS,
  HEARTBEAT_MAX_SKEW_MS,
  DISCONNECT_AFTER_BEATS,
} from "@/lib/messaging/wabridge-health"

const NOW = new Date("2026-09-24T18:00:00Z")
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const ok = { last_heartbeat_at: ago(60_000), reachable: true, connected: true, logged_in: true, bad_beats: 0 }

describe("classifyBridge", () => {
  it("is not monitored until the first heartbeat ever arrives (no false alarm on a fresh channel)", () => {
    expect(classifyBridge(null, NOW)).toBe("unmonitored")
    expect(classifyBridge({}, NOW)).toBe("unmonitored")
    expect(classifyBridge({ last_heartbeat_at: null }, NOW)).toBe("unmonitored")
  })
  it("ok when fresh, reachable, connected and logged in", () => expect(classifyBridge(ok, NOW)).toBe("ok"))
  it("offline when the heartbeat is stale (Mac off/asleep/offline), even if the last report was healthy", () => {
    expect(classifyBridge({ ...ok, last_heartbeat_at: ago(HEARTBEAT_STALE_MS + 1000) }, NOW)).toBe("offline")
    expect(classifyBridge({ ...ok, last_heartbeat_at: ago(HEARTBEAT_STALE_MS - 1000) }, NOW)).toBe("ok")
  })
  it("offline for an unparseable timestamp", () => expect(classifyBridge({ ...ok, last_heartbeat_at: "garbage" }, NOW)).toBe("offline"))
  it("process_down when the Mac reports but the bridge program does not answer", () => {
    expect(classifyBridge({ ...ok, reachable: false }, NOW)).toBe("process_down")
  })
  it("unlinked is immediate and needs logged_in=false", () => {
    expect(classifyBridge({ ...ok, logged_in: false }, NOW)).toBe("unlinked")
  })
  it("a single connected=false blip while still logged in is NOT an alarm (routine reconnect)", () => {
    expect(classifyBridge({ ...ok, connected: false, bad_beats: 1 }, NOW)).toBe("ok")
    expect(classifyBridge({ ...ok, connected: false, bad_beats: DISCONNECT_AFTER_BEATS - 1 }, NOW)).toBe("ok")
  })
  it("a sustained connected=false becomes 'disconnected'", () => {
    expect(classifyBridge({ ...ok, connected: false, bad_beats: DISCONNECT_AFTER_BEATS }, NOW)).toBe("disconnected")
  })
  it("process_down wins over unlinked (an unreachable bridge reports nothing reliable about the link)", () => {
    expect(classifyBridge({ ...ok, reachable: false, logged_in: false }, NOW)).toBe("process_down")
  })
})

describe("decideBridgeAlert", () => {
  it("does nothing for an unmonitored channel", () => expect(decideBridgeAlert(null, NOW)).toBeNull())

  it("alerts once on a new problem and records it", () => {
    const d = decideBridgeAlert({ ...ok, logged_in: false }, NOW)!
    expect(d).toMatchObject({ health: "unlinked", alert: true, nextAlertedState: "unlinked" })
    expect(d.reason).toMatch(/unlinked/i)
    expect(d.hint).toMatch(/Linked devices/)
  })

  it("does NOT re-alert on the next 5-minute tick for the same problem", () => {
    const d = decideBridgeAlert({ ...ok, logged_in: false, alerted_state: "unlinked" }, NOW)!
    expect(d).toMatchObject({ health: "unlinked", alert: false, nextAlertedState: undefined })
  })

  it("alerts again when the problem CHANGES (offline → process_down is new information)", () => {
    const d = decideBridgeAlert({ ...ok, reachable: false, alerted_state: "offline" }, NOW)!
    expect(d).toMatchObject({ health: "process_down", alert: true, nextAlertedState: "process_down" })
  })

  it("clears the marker on recovery, without an email, so a later outage alerts again", () => {
    expect(decideBridgeAlert({ ...ok, alerted_state: "offline" }, NOW)).toMatchObject({ health: "ok", alert: false, nextAlertedState: null })
    expect(decideBridgeAlert(ok, NOW)).toMatchObject({ health: "ok", alert: false, nextAlertedState: undefined })
  })

  it("a stale heartbeat alerts as offline exactly once", () => {
    const stale = { ...ok, last_heartbeat_at: ago(HEARTBEAT_STALE_MS + 60_000) }
    expect(decideBridgeAlert(stale, NOW)).toMatchObject({ health: "offline", alert: true })
    expect(decideBridgeAlert({ ...stale, alerted_state: "offline" }, NOW)).toMatchObject({ alert: false })
  })

  it("a routine reconnect blip sends NO email at all", () => {
    expect(decideBridgeAlert({ ...ok, connected: false, bad_beats: 2 }, NOW)).toMatchObject({ health: "ok", alert: false })
  })
})

describe("parseHeartbeat", () => {
  const beat = (over: Record<string, unknown> = {}) => ({
    event: "bridge.heartbeat", ts: NOW.getTime(), reachable: true, connected: true, logged_in: true, ...over,
  })
  it("accepts a fresh, complete heartbeat", () => {
    expect(parseHeartbeat(beat(), NOW)).toEqual({ ok: true, reachable: true, connected: true, logged_in: true })
  })
  it("rejects a REPLAYED heartbeat (old signed timestamp) — a captured beat can't hide an outage", () => {
    expect(parseHeartbeat(beat({ ts: NOW.getTime() - HEARTBEAT_MAX_SKEW_MS - 1000 }), NOW)).toMatchObject({ ok: false })
    expect(parseHeartbeat(beat({ ts: NOW.getTime() + HEARTBEAT_MAX_SKEW_MS + 1000 }), NOW)).toMatchObject({ ok: false })
  })
  it("rejects a missing/non-numeric timestamp", () => {
    expect(parseHeartbeat(beat({ ts: undefined }), NOW)).toMatchObject({ ok: false })
    expect(parseHeartbeat(beat({ ts: "now" }), NOW)).toMatchObject({ ok: false })
  })
  it("requires all three booleans — a buggy script that omits a field can no longer read as healthy", () => {
    for (const k of ["reachable", "connected", "logged_in"]) {
      expect(parseHeartbeat(beat({ [k]: undefined }), NOW)).toMatchObject({ ok: false })
      expect(parseHeartbeat(beat({ [k]: "yes" }), NOW)).toMatchObject({ ok: false })
    }
  })
  it("returns null for anything that is not a heartbeat", () => {
    for (const b of [null, undefined, 4, "x", {}, { event: "message" }]) expect(parseHeartbeat(b, NOW)).toBeNull()
  })
})
