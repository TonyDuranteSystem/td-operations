import { describe, it, expect } from "vitest"
import {
  listMessageIdsInWindow,
  reconcileWindow,
  type ReconcileIO,
} from "@/lib/email-store/reconcile"
import type { CaptureResult } from "@/lib/email-store/capture"

describe("listMessageIdsInWindow", () => {
  it("builds an after:/before: query excluding spam+trash and pages through", async () => {
    const seenQueries: string[] = []
    const pages: Record<string, any> = {
      "": { messages: [{ id: "a", threadId: "t" }], nextPageToken: "p2" },
      p2: { messages: [{ id: "b", threadId: "t" }], nextPageToken: undefined },
    }
    const get = async (_e: string, params?: Record<string, string>) => {
      seenQueries.push(params?.q ?? "")
      return pages[params?.pageToken ?? ""]
    }
    const refs = await listMessageIdsInWindow("support@x", 1000, 2000, get)
    expect(refs.map((r) => r.id)).toEqual(["a", "b"])
    expect(seenQueries[0]).toBe("after:1000 before:2000 -in:spam -in:trash")
  })
})

describe("reconcileWindow", () => {
  function io(
    gmailIds: Array<{ id: string; threadId: string }>,
    completed: string[],
    results: Record<string, CaptureResult>,
  ): ReconcileIO {
    return {
      list: async () => gmailIds,
      completed: async () => new Set(completed),
      capture: async (a) => results[a.messageId] ?? { status: "complete", attachments: 0 },
    }
  }

  it("captures ONLY the ids Gmail has that we don't already store complete", async () => {
    const gmail = [
      { id: "a", threadId: "t" }, { id: "b", threadId: "t" },
      { id: "c", threadId: "t" }, { id: "d", threadId: "t" },
    ]
    // a, c already stored; b, d are the gap
    const captured: string[] = []
    const customIo: ReconcileIO = {
      list: async () => gmail,
      completed: async () => new Set(["a", "c"]),
      capture: async (arg) => { captured.push(arg.messageId); return { status: "complete", attachments: 0 } },
    }
    const tally = await reconcileWindow({ mailbox: "support", afterSec: 1, beforeSec: 2 }, customIo)
    expect(tally).toEqual({ mailbox: "support", inGmail: 4, alreadyStored: 2, missing: 2, repaired: 2, error: 0 })
    expect(captured.sort()).toEqual(["b", "d"])
  })

  it("reports errors when a repair fails (gap NOT silently closed)", async () => {
    const gmail = [{ id: "x", threadId: "t" }]
    const tally = await reconcileWindow(
      { mailbox: "support", afterSec: 1, beforeSec: 2 },
      io(gmail, [], { x: { status: "error", error: "boom" } }),
    )
    expect(tally.missing).toBe(1)
    expect(tally.repaired).toBe(0)
    expect(tally.error).toBe(1)
  })

  it("no-op when everything Gmail has is already stored", async () => {
    const gmail = [{ id: "a", threadId: "t" }, { id: "b", threadId: "t" }]
    const tally = await reconcileWindow(
      { mailbox: "antonio", afterSec: 1, beforeSec: 2 },
      io(gmail, ["a", "b"], {}),
    )
    expect(tally).toEqual({ mailbox: "antonio", inGmail: 2, alreadyStored: 2, missing: 0, repaired: 0, error: 0 })
  })

  it("rejects an inverted window", async () => {
    await expect(
      reconcileWindow({ mailbox: "support", afterSec: 2000, beforeSec: 1000 }, io([], [], {})),
    ).rejects.toThrow()
  })
})
