import { describe, it, expect } from "vitest"
import { captureBatch, type BatchIO } from "@/lib/email-store/worker"
import type { CaptureResult } from "@/lib/email-store/capture"

function io(
  targets: Array<{ messageId: string; threadId: string }>,
  results: CaptureResult[],
): { io: BatchIO; order: string[] } {
  const order: string[] = []
  let i = 0
  return {
    order,
    io: {
      findUncaptured: async () => targets,
      capture: async (a) => {
        order.push(a.messageId)
        return results[i++]
      },
    },
  }
}

describe("captureBatch", () => {
  it("tallies complete / skipped / error across the batch", async () => {
    const { io: fake } = io(
      [
        { messageId: "a", threadId: "t" },
        { messageId: "b", threadId: "t" },
        { messageId: "c", threadId: "t" },
        { messageId: "d", threadId: "t" },
      ],
      [
        { status: "complete", attachments: 2 },
        { status: "skipped" },
        { status: "error", error: "boom" },
        { status: "complete", attachments: 0 },
      ],
    )
    const tally = await captureBatch({ mailbox: "support", limit: 10 }, fake)
    expect(tally).toEqual({ found: 4, complete: 2, skipped: 1, error: 1 })
  })

  it("processes messages sequentially in order", async () => {
    const { io: fake, order } = io(
      [
        { messageId: "m1", threadId: "t" },
        { messageId: "m2", threadId: "t" },
      ],
      [{ status: "complete", attachments: 0 }, { status: "complete", attachments: 0 }],
    )
    await captureBatch({ mailbox: "support", limit: 10 }, fake)
    expect(order).toEqual(["m1", "m2"])
  })

  it("with concurrency > 1 still captures every target and tallies correctly", async () => {
    const targets = Array.from({ length: 20 }, (_, i) => ({ messageId: `m${i}`, threadId: "t" }))
    const results = targets.map(() => ({ status: "complete" as const, attachments: 0 }))
    const { io: fake, order } = io(targets, results)
    const tally = await captureBatch({ mailbox: "support", limit: 20, concurrency: 5 }, fake)
    expect(tally).toEqual({ found: 20, complete: 20, skipped: 0, error: 0 })
    expect(order.length).toBe(20)
    expect(new Set(order).size).toBe(20) // each processed exactly once, no dup/drop
  })

  it("handles an empty batch (nothing to capture)", async () => {
    const { io: fake } = io([], [])
    const tally = await captureBatch({ mailbox: "antonio", limit: 10 }, fake)
    expect(tally).toEqual({ found: 0, complete: 0, skipped: 0, error: 0 })
  })

  it("rejects an unknown mailbox", async () => {
    const { io: fake } = io([], [])
    // @ts-expect-error deliberately invalid mailbox
    await expect(captureBatch({ mailbox: "marketing", limit: 5 }, fake)).rejects.toThrow()
  })
})
