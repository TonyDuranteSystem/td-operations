import { describe, it, expect } from "vitest"
import { changesWaiting, WAIT_TICK_MS, type ChangesPage, type Cursor, type WaitDeps } from "@/lib/storage-app/changes"

const empty = (cursor: string | null = null): ChangesPage => ({ changes: [], cursor, resync: false, hasMore: false })
const one: ChangesPage = { changes: [{ kind: "file", id: "f1", op: "upsert", ownerId: "o", parentId: "p", oldOwnerId: null, oldParentId: null, name: "A.pdf" }], cursor: "5.9", resync: false, hasMore: false }

function harness(script: ChangesPage[], opts: { abortAfter?: number } = {}) {
  let t = 0, i = 0
  const sleeps: number[] = [], seen: Array<Cursor | null> = []
  const deps: WaitDeps = {
    read: async (from) => { seen.push(from); return script[Math.min(i++, script.length - 1)] },
    sleep: async (ms) => { sleeps.push(ms); t += ms },
    now: () => t,
    aborted: () => opts.abortAfter !== undefined && i >= opts.abortAfter,
  }
  return { deps, sleeps, seen, reads: () => i }
}

describe("changesWaiting — the instant answer", () => {
  it("answers at once when something already changed (never sleeps)", async () => {
    const h = harness([one]); const r = await changesWaiting(null, 20_000, h.deps)
    expect(r.changes).toHaveLength(1); expect(h.sleeps).toEqual([]); expect(h.reads()).toBe(1)
  })
  it("wait 0 = the plain answer, even when empty", async () => {
    const h = harness([empty()]); const r = await changesWaiting(null, 0, h.deps)
    expect(r.changes).toHaveLength(0); expect(h.sleeps).toEqual([])
  })
  it("keeps asking until a change shows up, then answers with it", async () => {
    const h = harness([empty(), empty(), one]); const r = await changesWaiting(null, 20_000, h.deps)
    expect(r.changes).toHaveLength(1); expect(h.sleeps).toEqual([WAIT_TICK_MS, WAIT_TICK_MS])
  })
  it("gives up when the wait is over and answers empty", async () => {
    const h = harness([empty()]); const r = await changesWaiting(null, 4_000, h.deps)
    expect(r.changes).toHaveLength(0); expect(h.sleeps.reduce((a, b) => a + b, 0)).toBe(4_000)
  })
  it("a resync answers at once", async () => {
    const h = harness([{ changes: [], cursor: null, resync: true, hasMore: false }]); const r = await changesWaiting(null, 20_000, h.deps)
    expect(r.resync).toBe(true); expect(h.sleeps).toEqual([])
  })
  it("stops waiting when the Mac hung up", async () => {
    const h = harness([empty()], { abortAfter: 2 }); await changesWaiting(null, 20_000, h.deps)
    expect(h.reads()).toBeLessThanOrEqual(3)
  })
  it("rows this login may not see move the cursor on, so they are not re-read every tick", async () => {
    const h = harness([empty("7.1"), one]); await changesWaiting(null, 20_000, h.deps)
    expect(h.seen[0]).toBeNull(); expect(h.seen[1]).toEqual({ txid: "7", seq: 1 })
  })
})
