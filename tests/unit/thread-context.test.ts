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
  HISTORY_WATERMARK,
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
