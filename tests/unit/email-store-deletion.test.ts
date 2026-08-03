import { describe, it, expect } from "vitest"
import {
  isPastRetention,
  objectsToPurge,
  purgeExpired,
  BIN_RETENTION_DAYS,
  PURGE_NOW_ISO,
  type PurgeIO,
} from "@/lib/email-store/deletion"

const DAY = 86_400_000
const NOW = Date.parse("2026-08-04T00:00:00.000Z")
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()

describe("isPastRetention", () => {
  it("keeps live copies forever (no deletion stamp)", () => {
    expect(isPastRetention(null, NOW)).toBe(false)
    expect(isPastRetention(undefined, NOW)).toBe(false)
  })

  it("keeps a deleted copy for the whole 180-day window", () => {
    expect(isPastRetention(ago(1), NOW)).toBe(false)
    expect(isPastRetention(ago(30), NOW)).toBe(false)   // Gmail purged its own trash; ours stays
    expect(isPastRetention(ago(179), NOW)).toBe(false)
  })

  it("purges once the window has elapsed", () => {
    expect(isPastRetention(ago(BIN_RETENTION_DAYS), NOW)).toBe(true)
    expect(isPastRetention(ago(365), NOW)).toBe(true)
  })

  it("delete-forever's epoch stamp is immediately past retention", () => {
    expect(isPastRetention(PURGE_NOW_ISO, NOW)).toBe(true)
  })

  it("keeps (never guesses) on an unparseable stamp", () => {
    expect(isPastRetention("not-a-date", NOW)).toBe(false)
  })
})

describe("objectsToPurge", () => {
  it("collects the body and every attachment", () => {
    expect(objectsToPurge({ bodyPath: "s/m/body.html", attachmentPaths: ["s/m/att/a", "s/m/att/b"] }))
      .toEqual(["s/m/body.html", "s/m/att/a", "s/m/att/b"])
  })

  it("skips missing paths and de-duplicates", () => {
    expect(objectsToPurge({ bodyPath: null, attachmentPaths: ["s/m/att/a", "s/m/att/a", "", null] }))
      .toEqual(["s/m/att/a"])
  })

  it("returns nothing when there is nothing stored", () => {
    expect(objectsToPurge({ bodyPath: null, attachmentPaths: [] })).toEqual([])
  })
})

function io(
  expired: Array<{ mailbox: "support" | "antonio"; messageId: string; bodyPath: string | null; attachmentPaths: string[] }>,
  opts: { failObjectsFor?: string } = {},
) {
  const order: string[] = []
  const rowsRemoved: string[] = []
  const objectsRemoved: string[] = []
  const impl: PurgeIO = {
    listExpired: async () => expired,
    removeObjects: async (paths) => {
      if (opts.failObjectsFor && paths.some((p) => p.includes(opts.failObjectsFor!))) {
        throw new Error("storage boom")
      }
      order.push("objects")
      objectsRemoved.push(...paths)
    },
    removeRows: async (_mb, id) => {
      order.push("rows")
      rowsRemoved.push(id)
    },
  }
  return { impl, order, rowsRemoved, objectsRemoved }
}

describe("purgeExpired", () => {
  it("removes storage BEFORE the row (never strand bytes)", async () => {
    const h = io([{ mailbox: "support", messageId: "m1", bodyPath: "s/m1/body.html", attachmentPaths: ["s/m1/att/a"] }])
    const tally = await purgeExpired(NOW, h.impl)
    expect(h.order).toEqual(["objects", "rows"])
    expect(tally).toEqual({ examined: 1, purged: 1, objectsRemoved: 2, errors: 0 })
  })

  it("keeps the row when storage removal fails, so the sweep can retry", async () => {
    const h = io(
      [{ mailbox: "support", messageId: "m1", bodyPath: "s/m1/body.html", attachmentPaths: [] }],
      { failObjectsFor: "m1" },
    )
    const tally = await purgeExpired(NOW, h.impl)
    expect(h.rowsRemoved).toEqual([])       // row survives → retried next sweep
    expect(tally.errors).toBe(1)
    expect(tally.purged).toBe(0)
  })

  it("one failure does not stop the rest of the batch", async () => {
    const h = io(
      [
        { mailbox: "support", messageId: "bad", bodyPath: "s/bad/body.html", attachmentPaths: [] },
        { mailbox: "support", messageId: "good", bodyPath: "s/good/body.html", attachmentPaths: [] },
      ],
      { failObjectsFor: "bad" },
    )
    const tally = await purgeExpired(NOW, h.impl)
    expect(h.rowsRemoved).toEqual(["good"])
    expect(tally).toMatchObject({ examined: 2, purged: 1, errors: 1 })
  })

  it("still removes the row when a message has no stored objects", async () => {
    const h = io([{ mailbox: "antonio", messageId: "m2", bodyPath: null, attachmentPaths: [] }])
    const tally = await purgeExpired(NOW, h.impl)
    expect(h.rowsRemoved).toEqual(["m2"])
    expect(tally.objectsRemoved).toBe(0)
    expect(tally.purged).toBe(1)
  })

  it("does nothing when nothing has expired", async () => {
    const h = io([])
    expect(await purgeExpired(NOW, h.impl)).toEqual({ examined: 0, purged: 0, objectsRemoved: 0, errors: 0 })
  })
})
