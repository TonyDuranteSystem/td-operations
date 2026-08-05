import { describe, it, expect, beforeEach } from "vitest"
import {
  trackOpenMarkRead,
  openMarkReadSettled,
  _clearPendingMarkRead,
} from "@/lib/inbox/pending-mark-read"

// The race this module exists to close: the open-time auto-mark-read is slow
// and, raced with the header's "Mark unread", lands last and silently undoes
// the user's choice.

describe("pending-mark-read serializer", () => {
  beforeEach(() => _clearPendingMarkRead())

  it("resolves immediately when nothing is in flight", async () => {
    await expect(openMarkReadSettled("gmail:none")).resolves.toBeUndefined()
  })

  it("waits until the tracked call settles — the user's write lands last", async () => {
    let finishAutoRead!: () => void
    const autoRead = new Promise<void>((r) => (finishAutoRead = r))
    trackOpenMarkRead("gmail:t1", autoRead)

    const order: string[] = []
    const waiter = openMarkReadSettled("gmail:t1").then(() => order.push("mark_unread"))
    order.push("auto-read still in flight")
    finishAutoRead()
    await waiter
    expect(order).toEqual(["auto-read still in flight", "mark_unread"])
  })

  // A failed auto-read must never wedge the button.
  it("settles even when the tracked call rejects", async () => {
    trackOpenMarkRead("gmail:t2", Promise.reject(new Error("network")))
    await expect(openMarkReadSettled("gmail:t2")).resolves.toBeUndefined()
  })

  it("scopes by conversation — thread B never waits on thread A", async () => {
    trackOpenMarkRead("gmail:a", new Promise(() => {})) // never settles
    await expect(openMarkReadSettled("gmail:b")).resolves.toBeUndefined()
  })

  it("cleans up after itself so a settled call is not awaited forever", async () => {
    trackOpenMarkRead("gmail:t3", Promise.resolve())
    await openMarkReadSettled("gmail:t3")
    // Second await must be the immediate path (no stale entry).
    await expect(openMarkReadSettled("gmail:t3")).resolves.toBeUndefined()
  })

  it("a fast re-open replaces the entry; the old settle does not delete the new one", async () => {
    let finishFirst!: () => void
    const first = new Promise<void>((r) => (finishFirst = r))
    trackOpenMarkRead("gmail:t4", first)
    const second = new Promise<void>(() => {}) // still in flight
    trackOpenMarkRead("gmail:t4", second)
    finishFirst()
    await first
    // flush the first entry's finally
    await new Promise((r) => setTimeout(r, 0))
    let settled = false
    void openMarkReadSettled("gmail:t4").then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false) // still waiting on the SECOND call
  })
})
