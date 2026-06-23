/**
 * Hermes ↔ Claude bridge — Phase C: thread context watermark.
 * Pairs with lib/ai-agent/thread-context.ts (pure formatThreadContext).
 *
 * Pins: chronological ordering, role labels (Antonio directed / Hermes said /
 * Claude said), and the >20-message watermark (older folded into a preamble).
 */

import { describe, it, expect } from "vitest"
import {
  formatThreadContext,
  formatRecalledTurns,
  HISTORY_WATERMARK,
  RECALL_MAX_TURNS,
  type ThreadMessageRow,
} from "@/lib/ai-agent/thread-context"

function msg(partial: Partial<ThreadMessageRow> & { id: string; created_at: string }): ThreadMessageRow {
  return {
    sender: "hermes",
    recipient: "claude",
    body: "body",
    reply: null,
    ...partial,
  }
}

describe("formatThreadContext — empty / trivial", () => {
  it("returns empty text for no rows", () => {
    const ctx = formatThreadContext("t1", [])
    expect(ctx.messageCount).toBe(0)
    expect(ctx.summarizedCount).toBe(0)
    expect(ctx.text).toBe("")
  })
})

describe("formatThreadContext — role labels", () => {
  it("labels the FIRST hermes message 'Antonio directed' and later ones 'Hermes said'", () => {
    const rows = [
      msg({ id: "a", created_at: "2026-06-04T00:00:00Z", sender: "hermes", body: "first question" }),
      msg({ id: "b", created_at: "2026-06-04T00:01:00Z", sender: "hermes", body: "follow up" }),
    ]
    const ctx = formatThreadContext("t1", rows)
    expect(ctx.text).toContain("Antonio directed: first question")
    expect(ctx.text).toContain("Hermes said: follow up")
  })

  it("labels worker/claude turns 'Claude said' and renders replies as Claude", () => {
    const rows = [
      msg({ id: "a", created_at: "2026-06-04T00:00:00Z", sender: "hermes", body: "q", reply: "the answer" }),
      msg({ id: "b", created_at: "2026-06-04T00:01:00Z", sender: "worker", body: "an outcome note" }),
    ]
    const ctx = formatThreadContext("t1", rows)
    expect(ctx.text).toContain("Antonio directed: q")
    expect(ctx.text).toContain("Claude said: the answer")
    expect(ctx.text).toContain("Claude said: an outcome note")
  })

  it("sorts by created_at ascending regardless of input order", () => {
    const rows = [
      msg({ id: "late", created_at: "2026-06-04T09:00:00Z", body: "later" }),
      msg({ id: "early", created_at: "2026-06-04T08:00:00Z", body: "earlier" }),
    ]
    const ctx = formatThreadContext("t1", rows)
    expect(ctx.text.indexOf("earlier")).toBeLessThan(ctx.text.indexOf("later"))
  })
})

describe("formatThreadContext — watermark", () => {
  it("keeps all rows inline when count <= watermark (no preamble)", () => {
    const rows = Array.from({ length: HISTORY_WATERMARK }, (_, i) =>
      msg({ id: `m${i}`, created_at: `2026-06-04T00:${String(i).padStart(2, "0")}:00Z`, body: `q${i}` }),
    )
    const ctx = formatThreadContext("t1", rows)
    expect(ctx.messageCount).toBe(HISTORY_WATERMARK)
    expect(ctx.summarizedCount).toBe(0)
    expect(ctx.text).not.toContain("Earlier in this thread")
  })

  it("folds older rows into a summarized preamble when count > watermark", () => {
    const total = HISTORY_WATERMARK + 5
    const rows = Array.from({ length: total }, (_, i) =>
      msg({ id: `m${i}`, created_at: `2026-06-04T${String(i).padStart(2, "0")}:00:00Z`, body: `q${i}` }),
    )
    const ctx = formatThreadContext("t1", rows)
    expect(ctx.messageCount).toBe(total)
    expect(ctx.summarizedCount).toBe(5)
    expect(ctx.text).toContain("5 older message(s), summarized")
    expect(ctx.text).toContain(`Recent messages — last ${HISTORY_WATERMARK}`)
    // The very first message is in the summarized block...
    expect(ctx.text).toContain("q0")
    // ...and the latest is in the recent block.
    expect(ctx.text).toContain(`q${total - 1}`)
  })

  it("respects a custom watermark", () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      msg({ id: `m${i}`, created_at: `2026-06-04T0${i}:00:00Z`, body: `q${i}` }),
    )
    const ctx = formatThreadContext("t1", rows, 2)
    expect(ctx.summarizedCount).toBe(4)
    expect(ctx.text).toContain("4 older message(s), summarized")
  })

  it("attributes the first hermes message to Antonio even when it falls in the older block", () => {
    const total = HISTORY_WATERMARK + 2
    const rows = Array.from({ length: total }, (_, i) =>
      msg({ id: `m${i}`, created_at: `2026-06-04T${String(i).padStart(2, "0")}:00:00Z`, sender: "hermes", body: `q${i}` }),
    )
    const ctx = formatThreadContext("t1", rows)
    // q0 is the oldest → in the older block → must be "Antonio directed"
    expect(ctx.text).toContain("Antonio directed: q0")
  })
})

describe("formatRecalledTurns — on-demand thread recall (persistent memory Phase 1)", () => {
  it("with no query, returns ALL turns chronologically with date prefixes + replies", () => {
    const rows = [
      msg({ id: "b", created_at: "2026-03-02T00:00:00Z", sender: "hermes", body: "second", reply: "answer 2" }),
      msg({ id: "a", created_at: "2026-03-01T00:00:00Z", sender: "hermes", body: "first", reply: "answer 1" }),
    ]
    const res = formatRecalledTurns("t1", rows, null)
    expect(res.totalTurns).toBe(2)
    expect(res.matchedTurns).toBe(2)
    expect(res.truncated).toBe(false)
    expect(res.query).toBeNull()
    // chronological (oldest first) + date prefix + reply line
    expect(res.text.indexOf("first")).toBeLessThan(res.text.indexOf("second"))
    expect(res.text).toContain("[2026-03-01]")
    expect(res.text).toContain("Claude said: answer 1")
  })

  it("with a query, keeps only turns whose body OR reply contains it (case-insensitive)", () => {
    const rows = [
      msg({ id: "a", created_at: "2026-03-01T00:00:00Z", body: "talk about the INVOICE", reply: null }),
      msg({ id: "b", created_at: "2026-03-02T00:00:00Z", body: "unrelated", reply: "we sent the Invoice yesterday" }),
      msg({ id: "c", created_at: "2026-03-03T00:00:00Z", body: "weather", reply: "sunny" }),
    ]
    const res = formatRecalledTurns("t1", rows, "invoice")
    expect(res.totalTurns).toBe(3)
    expect(res.matchedTurns).toBe(2)
    expect(res.query).toBe("invoice")
    expect(res.text).toContain("INVOICE")
    expect(res.text).toContain("we sent the Invoice yesterday")
    expect(res.text).not.toContain("weather")
  })

  it("returns matchedTurns=0 and empty text when nothing matches the query", () => {
    const rows = [msg({ id: "a", created_at: "2026-03-01T00:00:00Z", body: "hello", reply: "hi" })]
    const res = formatRecalledTurns("t1", rows, "nonexistent-term")
    expect(res.totalTurns).toBe(1)
    expect(res.matchedTurns).toBe(0)
    expect(res.text).toBe("")
  })

  it("keeps the MOST RECENT maxTurns matches and flags truncation", () => {
    const rows = Array.from({ length: RECALL_MAX_TURNS + 5 }, (_, i) =>
      msg({ id: `m${i}`, created_at: `2026-03-${String(i + 1).padStart(2, "0")}T00:00:00Z`, body: `turn ${i}`, reply: null }),
    )
    const res = formatRecalledTurns("t1", rows, null)
    expect(res.totalTurns).toBe(RECALL_MAX_TURNS + 5)
    expect(res.truncated).toBe(true)
    expect(res.text).toContain(`${RECALL_MAX_TURNS} most recent`)
    // the oldest 5 turns (0..4) were dropped; the newest is kept
    expect(res.text).not.toContain("turn 0")
    expect(res.text).toContain(`turn ${RECALL_MAX_TURNS + 4}`)
  })

  it("returns an empty result for a falsy thread id is handled by recallThreadHistory, but the formatter is pure on []", () => {
    const res = formatRecalledTurns("t1", [], null)
    expect(res.totalTurns).toBe(0)
    expect(res.matchedTurns).toBe(0)
    expect(res.text).toBe("")
  })
})
