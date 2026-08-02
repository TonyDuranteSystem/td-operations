import { describe, it, expect } from "vitest"
import {
  enumerateMessageIds,
  drainPool,
  runFullBackfill,
  type BackfillIO,
} from "@/lib/email-store/runner"
import type { CaptureResult } from "@/lib/email-store/capture"

describe("enumerateMessageIds", () => {
  it("pages through messages.list until no nextPageToken", async () => {
    const pages: Record<string, any> = {
      "": { messages: [{ id: "a", threadId: "t1" }, { id: "b", threadId: "t1" }], nextPageToken: "p2" },
      p2: { messages: [{ id: "c", threadId: "t2" }], nextPageToken: undefined },
    }
    const get = async (_e: string, params?: Record<string, string>) => pages[params?.pageToken ?? ""]
    const refs = await enumerateMessageIds("support@x", get)
    expect(refs.map((r) => r.id)).toEqual(["a", "b", "c"])
    expect(refs[0].threadId).toBe("t1")
  })

  it("handles an empty mailbox", async () => {
    const get = async () => ({ messages: [], nextPageToken: undefined })
    expect(await enumerateMessageIds("support@x", get)).toEqual([])
  })
})

describe("drainPool", () => {
  it("processes every item exactly once under concurrency", async () => {
    const items = Array.from({ length: 50 }, (_, i) => i)
    const seen: number[] = []
    await drainPool(items, 8, async (i) => { seen.push(i) })
    expect(seen.length).toBe(50)
    expect(new Set(seen).size).toBe(50)
  })

  it("respects the concurrency ceiling (never more than N in flight)", async () => {
    const items = Array.from({ length: 30 }, (_, i) => i)
    let inFlight = 0
    let peak = 0
    await drainPool(items, 5, async () => {
      inFlight++; peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
    })
    expect(peak).toBeLessThanOrEqual(5)
  })

  it("handles an empty list", async () => {
    let calls = 0
    await drainPool([], 4, async () => { calls++ })
    expect(calls).toBe(0)
  })
})

describe("runFullBackfill", () => {
  function io(refs: Array<{ id: string; threadId: string }>, results: Record<string, CaptureResult>): BackfillIO {
    return {
      enumerate: async () => refs,
      capture: async (a) => results[a.messageId],
    }
  }

  it("enumerates then captures all, tallying complete/skipped/error", async () => {
    const refs = [
      { id: "a", threadId: "t" }, { id: "b", threadId: "t" },
      { id: "c", threadId: "t" }, { id: "d", threadId: "t" },
    ]
    const tally = await runFullBackfill({ mailbox: "support", concurrency: 3 }, io(refs, {
      a: { status: "complete", attachments: 1 },
      b: { status: "skipped" },
      c: { status: "error", error: "x" },
      d: { status: "complete", attachments: 0 },
    }))
    expect(tally).toEqual({ mailbox: "support", enumerated: 4, complete: 2, skipped: 1, error: 1 })
  })

  it("rejects an unknown mailbox", async () => {
    // @ts-expect-error invalid mailbox on purpose
    await expect(runFullBackfill({ mailbox: "x" }, io([], {}))).rejects.toThrow()
  })
})
