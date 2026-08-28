import { describe, it, expect } from "vitest"
import { repairIsHtmlBatch, repairAllIsHtml, type RepairIO } from "@/lib/email-store/repair-is-html"

function makeIO(over: Partial<RepairIO> = {}): { io: RepairIO; updated: Record<string, boolean>; unresolved: string[] } {
  const updated: Record<string, boolean> = {}
  const unresolved: string[] = []
  const io: RepairIO = {
    fetchPending: async () => [{ message_id: "m1" }, { message_id: "m2" }],
    resolveIsHtml: async (_mailbox, messageId) => messageId === "m1",
    updateIsHtml: async (_mailbox, messageId, isHtml) => { updated[messageId] = isHtml },
    markUnresolvable: async (_mailbox, messageId) => { unresolved.push(messageId) },
    ...over,
  }
  return { io, updated, unresolved }
}

describe("repairIsHtmlBatch", () => {
  it("resolves and persists the real flag for each pending row", async () => {
    const { io, updated } = makeIO()
    const res = await repairIsHtmlBatch("support", io)
    expect(res).toEqual({ mailbox: "support", fetched: 2, updated: 2, errors: 0 })
    expect(updated).toEqual({ m1: true, m2: false })
  })

  it("never touches body_path/body_text/capture_status — only calls updateIsHtml", async () => {
    const calls: string[] = []
    const { io } = makeIO({
      updateIsHtml: async (mailbox, messageId, isHtml) => { calls.push(`${mailbox}:${messageId}:${isHtml}`) },
    })
    await repairIsHtmlBatch("support", io)
    expect(calls).toEqual(["support:m1:true", "support:m2:false"])
  })

  it("one message's failure doesn't abort the batch — it's counted and left for next run", async () => {
    const { io, updated } = makeIO({
      resolveIsHtml: async (_mb, id) => {
        if (id === "m1") throw new Error("Gmail API 500: transient")
        return false
      },
    })
    const res = await repairIsHtmlBatch("support", io)
    expect(res).toEqual({ mailbox: "support", fetched: 2, updated: 1, errors: 1 })
    expect(updated).toEqual({ m2: false })
  })

  it("marks a permanently-gone message (404) unresolvable instead of retrying it forever", async () => {
    const { io, unresolved } = makeIO({
      resolveIsHtml: async (_mb, id) => {
        if (id === "m1") throw new Error("Gmail API 404: not found")
        return false
      },
    })
    await repairIsHtmlBatch("support", io)
    expect(unresolved).toEqual(["m1"])
  })

  it("does not mark unresolvable for a non-404 error", async () => {
    const { io, unresolved } = makeIO({
      resolveIsHtml: async (_mb, id) => {
        if (id === "m1") throw new Error("Gmail API 429: rate limited")
        return false
      },
    })
    await repairIsHtmlBatch("support", io)
    expect(unresolved).toEqual([])
  })

  it("respects the batch limit passed to fetchPending", async () => {
    let requestedLimit: number | undefined
    const { io } = makeIO({
      fetchPending: async (_mb, limit) => { requestedLimit = limit; return [] },
    })
    await repairIsHtmlBatch("support", io, { limit: 50 })
    expect(requestedLimit).toBe(50)
  })
})

describe("repairAllIsHtml", () => {
  it("loops batches until fetchPending returns empty, accumulating totals", async () => {
    let call = 0
    const batches = [
      [{ message_id: "a" }, { message_id: "b" }],
      [{ message_id: "c" }],
      [],
    ]
    const { io } = makeIO({
      fetchPending: async () => batches[call++],
      resolveIsHtml: async () => true,
    })
    const totals = await repairAllIsHtml("support", io, { sleepMs: 0 })
    expect(totals).toEqual({ mailbox: "support", batches: 3, updated: 3, errors: 0 })
  })

  it("stops immediately when there is nothing pending (no-op, no sleep)", async () => {
    const { io } = makeIO({ fetchPending: async () => [] })
    const totals = await repairAllIsHtml("support", io, { sleepMs: 0 })
    expect(totals).toEqual({ mailbox: "support", batches: 1, updated: 0, errors: 0 })
  })

  it("calls onBatch with each batch's result", async () => {
    let call = 0
    const batches = [[{ message_id: "a" }], []]
    const { io } = makeIO({ fetchPending: async () => batches[call++], resolveIsHtml: async () => true })
    const seen: number[] = []
    await repairAllIsHtml("support", io, { sleepMs: 0, onBatch: (r) => seen.push(r.fetched) })
    expect(seen).toEqual([1, 0])
  })
})
