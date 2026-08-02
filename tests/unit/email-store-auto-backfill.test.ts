import { describe, it, expect } from "vitest"
import { runBackfillTick, type TickIO } from "@/lib/email-store/auto-backfill"
import type { ReconcileTally } from "@/lib/email-store/reconcile"

const DAY = 86400
const tally = (over: Partial<ReconcileTally> = {}): ReconcileTally => ({
  mailbox: "support", inGmail: 0, alreadyStored: 0, missing: 0, repaired: 0, error: 0, ...over,
})

/** In-memory IO with a controllable monotonic clock. */
function harness(opts: { nowSec: number; floorSec: number; msPerWindow?: number }) {
  const state: { cursor: number | null; done: boolean } = { cursor: null, done: false }
  const windowsReconciled: Array<[number, number]> = []
  let clock = 0
  const io: TickIO = {
    getCursor: async () => ({ cursorSec: state.cursor, done: state.done }),
    setCursor: async (_m, c, d) => { state.cursor = c; state.done = d },
    floorSec: async () => opts.floorSec,
    reconcile: async (_m, a, b) => {
      windowsReconciled.push([a, b])
      clock += opts.msPerWindow ?? 10_000
      return tally({ inGmail: 5, repaired: 2 })
    },
  }
  return { io, state, windowsReconciled, now: () => clock }
}

describe("runBackfillTick", () => {
  it("walks windows backward and finishes when it reaches the floor", async () => {
    // 40-day span, 14-day windows → ~3 windows to reach floor
    const nowSec = 1_754_000_000
    const floorSec = nowSec - 40 * DAY
    const h = harness({ nowSec, floorSec, msPerWindow: 1000 })
    const res = await runBackfillTick(
      { mailbox: "support", budgetMs: 1_000_000, windowDays: 14, nowSec, monotonicMs: h.now },
      h.io,
    )
    expect(res.done).toBe(true)
    expect(h.state.done).toBe(true)
    expect(res.captured).toBeGreaterThan(0)
    // windows cover newest→oldest and none dips below the floor
    const oldest = Math.min(...h.windowsReconciled.map(([a]) => a))
    expect(oldest).toBeGreaterThanOrEqual(floorSec)
  })

  it("stops at the time budget and resumes from the saved cursor next tick", async () => {
    const nowSec = 1_754_000_000
    const floorSec = nowSec - 200 * DAY
    const h = harness({ nowSec, floorSec, msPerWindow: 60_000 }) // 60s/window
    const first = await runBackfillTick(
      { mailbox: "support", budgetMs: 130_000, windowDays: 14, nowSec, monotonicMs: h.now },
      h.io,
    )
    expect(first.done).toBe(false)          // budget ran out before the floor
    expect(first.windows).toBeGreaterThan(0)
    const cursorAfterFirst = h.state.cursor!
    expect(cursorAfterFirst).toBeLessThan(nowSec)

    // next tick resumes from the saved cursor (older than where we stopped)
    const before = h.windowsReconciled.length
    await runBackfillTick(
      { mailbox: "support", budgetMs: 130_000, windowDays: 14, nowSec, monotonicMs: h.now },
      h.io,
    )
    const firstResumedWindow = h.windowsReconciled[before]
    expect(firstResumedWindow[1]).toBe(cursorAfterFirst) // continued, not restarted
  })

  it("does nothing when the mailbox is already marked done", async () => {
    const h = harness({ nowSec: 1_754_000_000, floorSec: 1_753_000_000 })
    h.state.done = true
    const res = await runBackfillTick({ mailbox: "support", monotonicMs: h.now }, h.io)
    expect(res.done).toBe(true)
    expect(res.windows).toBe(0)
    expect(h.windowsReconciled).toEqual([])
  })

  it("rejects an unknown mailbox", async () => {
    const h = harness({ nowSec: 1, floorSec: 1 })
    // @ts-expect-error invalid mailbox
    await expect(runBackfillTick({ mailbox: "x" }, h.io)).rejects.toThrow()
  })
})
