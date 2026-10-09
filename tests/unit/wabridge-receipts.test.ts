import { describe, it, expect } from "vitest"
import { parseReceiptEvent, isReceiptEvent, tickState, tickLabel, MAX_RECEIPT_IDS, SENT_TICK_WINDOW_MS } from "@/lib/messaging/wabridge-receipts"

const NOW = new Date("2026-10-09T12:00:00Z")
const ev = (payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  event: "message.ack",
  timestamp: "2026-10-09T11:59:00Z",
  payload,
  ...extra,
})

describe("parseReceiptEvent", () => {
  it("accepts a delivered receipt", () => {
    const r = parseReceiptEvent(ev({ ids: ["A1"], chat_id: "15551234567@s.whatsapp.net", receipt_type: "delivered" }), NOW)
    expect(r).toEqual({ action: "apply", ids: ["A1"], kind: "delivered", at: "2026-10-09T11:59:00.000Z" })
  })
  it("accepts read, case-insensitive, dedupes ids", () => {
    const r = parseReceiptEvent(ev({ ids: ["A1", "A1", "B2"], chat_id: "1@s.whatsapp.net", receipt_type: "READ" }), NOW)
    expect(r).toMatchObject({ action: "apply", kind: "read", ids: ["A1", "B2"] })
  })
  it("caps the number of ids", () => {
    const ids = Array.from({ length: MAX_RECEIPT_IDS + 50 }, (_, i) => `id${i}`)
    const r = parseReceiptEvent(ev({ ids, chat_id: "1@s.whatsapp.net", receipt_type: "read" }), NOW)
    expect(r.action === "apply" && r.ids.length).toBe(MAX_RECEIPT_IDS)
  })
  it("uses now for a missing, garbage or future timestamp", () => {
    const p = { ids: ["A"], chat_id: "1@s.whatsapp.net", receipt_type: "read" }
    for (const timestamp of [undefined, "nope", "2030-01-01T00:00:00Z"]) {
      const r = parseReceiptEvent({ event: "message.ack", timestamp, payload: p }, NOW)
      expect(r.action === "apply" && r.at).toBe(NOW.toISOString())
    }
  })
  it("ignores other receipt types (played, sender, retry…)", () => {
    for (const t of ["played", "sender", "retry", "", undefined, 5]) {
      expect(parseReceiptEvent(ev({ ids: ["A"], chat_id: "1@s.whatsapp.net", receipt_type: t }), NOW).action).toBe("ignore")
    }
  })
  it("ignores groups, status, newsletters", () => {
    for (const chat_id of ["12036@g.us", "status@broadcast", "1@newsletter"]) {
      expect(parseReceiptEvent(ev({ ids: ["A"], chat_id, receipt_type: "read" }), NOW).action).toBe("ignore")
    }
  })
  it("ignores empty / non-string / oversized ids and bad shapes", () => {
    const base = { chat_id: "1@s.whatsapp.net", receipt_type: "read" }
    expect(parseReceiptEvent(ev({ ...base, ids: [] }), NOW).action).toBe("ignore")
    expect(parseReceiptEvent(ev({ ...base, ids: [1, null, "", "x".repeat(200)] }), NOW).action).toBe("ignore")
    expect(parseReceiptEvent(ev({ ...base, ids: "A" }), NOW).action).toBe("ignore")
    expect(parseReceiptEvent(ev({ ...base }), NOW).action).toBe("ignore")
    expect(parseReceiptEvent({ event: "message.ack" }, NOW).action).toBe("ignore")
    expect(parseReceiptEvent({ event: "message" }, NOW).action).toBe("ignore")
    expect(parseReceiptEvent(null, NOW).action).toBe("ignore")
    expect(parseReceiptEvent([], NOW).action).toBe("ignore")
  })
  it("isReceiptEvent only for message.ack", () => {
    expect(isReceiptEvent({ event: "message.ack" })).toBe(true)
    expect(isReceiptEvent({ event: "message" })).toBe(false)
    expect(isReceiptEvent(null)).toBe(false)
  })
})

describe("tickState", () => {
  const fresh = new Date(NOW.getTime() - 3_600_000).toISOString()
  const old = new Date(NOW.getTime() - SENT_TICK_WINDOW_MS - 1000).toISOString()
  it("read wins over delivered", () => {
    expect(tickState({ created_at: old, delivered_at: "x", read_at: "y" }, NOW)).toBe("read")
  })
  it("delivered", () => {
    expect(tickState({ created_at: old, delivered_at: "x" }, NOW)).toBe("delivered")
  })
  it("fresh with no receipt = sent", () => {
    expect(tickState({ created_at: fresh }, NOW)).toBe("sent")
  })
  it("old with no receipt = unknown (nothing drawn)", () => {
    expect(tickState({ created_at: old }, NOW)).toBeNull()
    expect(tickState({ created_at: "garbage" }, NOW)).toBeNull()
  })
})

describe("tickLabel", () => {
  const fmt = (s: string) => `<${s}>`
  it("labels each state", () => {
    expect(tickLabel("read", { read_at: "R" }, fmt)).toBe("Read · <R>")
    expect(tickLabel("delivered", { delivered_at: "D" }, fmt)).toBe("Delivered · <D>")
    expect(tickLabel("sent", {}, fmt)).toBe("Sent")
  })
})
