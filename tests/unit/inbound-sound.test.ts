import { describe, it, expect } from "vitest"
import { isFreshInbound, inboundSignalPayload, FRESH_INBOUND_MAX_AGE_MS } from "@/lib/messaging/inbound-sound"

const NOW = new Date("2026-10-07T20:00:00.000Z")
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

describe("isFreshInbound — which messages ring the CRM", () => {
  it("a customer message that just arrived rings", () => {
    expect(isFreshInbound("inbound", ago(2_000), NOW)).toBe(true)
  })
  it("never for our own reply or something typed on the phone", () => {
    expect(isFreshInbound("outbound", ago(1_000), NOW)).toBe(false)
  })
  it("never for history or a delayed delivery older than 3 minutes", () => {
    expect(isFreshInbound("inbound", ago(FRESH_INBOUND_MAX_AGE_MS), NOW)).toBe(true)
    expect(isFreshInbound("inbound", ago(FRESH_INBOUND_MAX_AGE_MS + 1_000), NOW)).toBe(false)
    expect(isFreshInbound("inbound", ago(3 * 3600_000), NOW)).toBe(false)
  })
  it("tolerates a little clock skew, rejects a nonsense future time", () => {
    expect(isFreshInbound("inbound", ago(-60_000), NOW)).toBe(true)
    expect(isFreshInbound("inbound", ago(-20 * 60_000), NOW)).toBe(false)
  })
  it("garbage in → silence", () => {
    expect(isFreshInbound("inbound", "not a date", NOW)).toBe(false)
    expect(isFreshInbound("", ago(1_000), NOW)).toBe(false)
  })
})

describe("inboundSignalPayload", () => {
  it("is only a small count, and absent when nothing rang", () => {
    expect(inboundSignalPayload(1)).toEqual({ inbound: 1 })
    expect(inboundSignalPayload(500)).toEqual({ inbound: 99 })
    expect(inboundSignalPayload(0)).toBeUndefined()
    expect(inboundSignalPayload(-3)).toBeUndefined()
    expect(inboundSignalPayload(1.5)).toBeUndefined()
    expect(inboundSignalPayload(Number.NaN)).toBeUndefined()
  })
})
