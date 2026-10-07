import { describe, it, expect } from "vitest"
import {
  parseReactionsBatch,
  mergeReactionResults,
  isValidObservedEmoji,
  stripVariationSelector,
  MAX_REACTION_ITEMS,
} from "@/lib/messaging/wabridge-reactions"

const NOW = new Date("2026-10-07T01:15:00Z")
const good = (over: Record<string, unknown> = {}) => ({ ext_id: "3A005FCF60C597CA99D0", chat: "17274234285", side: "client", op: "set", emoji: "👍", ...over })
const batch = (items: unknown, over: Record<string, unknown> = {}) => ({ ts: NOW.getTime(), scan_ms: NOW.getTime() - 5_000, items, ...over })

describe("isValidObservedEmoji", () => {
  it("accepts real emoji, flags, ZWJ sequences and keycaps (which contain a digit)", () => {
    for (const e of ["👍", "❤️", "❤", "😂", "🇮🇹", "👨‍👩‍👧‍👦", "1️⃣", "🙏🏽"]) expect(isValidObservedEmoji(e)).toBe(true)
  })
  it("rejects empty, long, spaced and plain letter/digit strings (a stranger's phone can send anything)", () => {
    for (const e of ["", "abc", "7", "👍 👍", "x".repeat(33), "👍".repeat(20), 5, null, undefined]) expect(isValidObservedEmoji(e)).toBe(false)
  })
})

describe("stripVariationSelector", () => {
  it("makes ❤ and ❤️ the same emoji", () => {
    expect(stripVariationSelector("❤️")).toBe(stripVariationSelector("❤"))
  })
})

describe("parseReactionsBatch", () => {
  it("accepts a fresh batch and keeps every item's index", () => {
    const p = parseReactionsBatch(batch([good(), good({ emoji: "bad" }), good({ op: "remove", emoji: undefined })]), NOW)
    expect(p.ok).toBe(true)
    expect(p.scanMs).toBe(NOW.getTime() - 5_000)
    expect(p.entries.map((e) => [e.index, e.valid])).toEqual([[0, true], [1, false], [2, true]])
    expect(p.entries[0].item).toEqual({ ext_id: "3A005FCF60C597CA99D0", chat: "17274234285", side: "client", op: "set", emoji: "👍" })
    expect(p.entries[2].item?.op).toBe("remove")
    expect(p.entries[2].item?.emoji).toBeUndefined()
  })

  it("an empty batch is valid — it is the 'I am alive' beat", () => {
    const p = parseReactionsBatch(batch([]), NOW)
    expect(p.ok).toBe(true)
    expect(p.entries).toEqual([])
  })

  it("refuses a stale envelope, a missing/odd scan_ms, a scan older than 15 min or in the future", () => {
    expect(parseReactionsBatch(batch([], { ts: NOW.getTime() - 3600_000 }), NOW).ok).toBe(false)
    expect(parseReactionsBatch(batch([], { scan_ms: undefined }), NOW).reason).toBe("missing scan_ms")
    expect(parseReactionsBatch(batch([], { scan_ms: 1.5 }), NOW).ok).toBe(false)
    expect(parseReactionsBatch(batch([], { scan_ms: -4 }), NOW).ok).toBe(false)
    expect(parseReactionsBatch(batch([], { scan_ms: NOW.getTime() - 16 * 60_000 }), NOW).reason).toBe("scan_ms out of range")
    expect(parseReactionsBatch(batch([], { scan_ms: NOW.getTime() + 5 * 60_000 }), NOW).reason).toBe("scan_ms out of range")
  })

  it("refuses a non-array or oversized items list and a non-object body", () => {
    expect(parseReactionsBatch(batch("x"), NOW).reason).toBe("items must be an array")
    expect(parseReactionsBatch(batch(Array.from({ length: MAX_REACTION_ITEMS + 1 }, () => good())), NOW).reason).toBe("too many items")
    expect(parseReactionsBatch(null, NOW).ok).toBe(false)
    expect(parseReactionsBatch([], NOW).ok).toBe(false)
  })

  it("marks bad items invalid without failing the batch: ids, chats, sides, ops, set-without-emoji", () => {
    const p = parseReactionsBatch(batch([
      good({ ext_id: "x" }),
      good({ chat: "123" }),
      good({ chat: "17274234285@s.whatsapp.net" }),
      good({ side: "staff" }),
      good({ op: "toggle" }),
      good({ emoji: undefined }),
      "nope",
      null,
      good({ reacted_at: "not a date" }),
    ]), NOW)
    expect(p.ok).toBe(true)
    expect(p.entries.map((e) => e.valid)).toEqual([false, false, false, false, false, false, false, false, true])
    expect(p.entries[8].item?.reacted_at).toBeUndefined() // an unparseable time is dropped, the reaction is kept
  })

  it("keeps a parseable reacted_at (display only)", () => {
    const p = parseReactionsBatch(batch([good({ reacted_at: "2026-10-07T01:11:03Z" })]), NOW)
    expect(p.entries[0].item?.reacted_at).toBe("2026-10-07T01:11:03Z")
  })
})

describe("mergeReactionResults", () => {
  const entries = [
    { index: 0, valid: true },
    { index: 1, valid: false },
    { index: 2, valid: true },
  ]
  it("puts the database's answers back on the right submitted index and marks pre-filtered items invalid", () => {
    expect(mergeReactionResults(entries, [{ i: 0, r: "applied" }, { i: 1, r: "held" }])).toEqual([
      { i: 0, r: "applied" },
      { i: 1, r: "invalid" },
      { i: 2, r: "held" },
    ])
  })
  it("never silently drops a valid item the database did not answer, and ignores unknown answers", () => {
    expect(mergeReactionResults(entries, [{ i: 0, r: "applied" }])).toEqual([
      { i: 0, r: "applied" },
      { i: 1, r: "invalid" },
      { i: 2, r: "invalid" },
    ])
    expect(mergeReactionResults(entries, [{ i: 0, r: "weird" }, { i: 1, r: "noop" }])[0].r).toBe("invalid")
  })
})
