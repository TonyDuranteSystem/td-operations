import { describe, it, expect } from "vitest"
import {
  isPastRetention,
  objectsToPurge,
  binStateDrift,
  purgeExpired,
  purgeMessagesNow,
  BIN_RETENTION_DAYS,
  type PurgeIO,
  type ExpiredItem,
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

  it("keeps (never guesses) on an unparseable stamp", () => {
    expect(isPastRetention("not-a-date", NOW)).toBe(false)
  })
})

describe("binStateDrift — the sweep that makes the bin honest", () => {
  it("bins a copy whose email is in Gmail's Trash but was never stamped", () => {
    // The 246-copy backlog on production: deleted in Gmail, never via the CRM.
    expect(binStateDrift([{ messageId: "m1", labelIds: ["TRASH"], deletedAt: null }]))
      .toEqual({ toBin: ["m1"], toRestore: [] })
  })

  it("un-bins a copy that came back — restoring inside Gmail must stop the clock", () => {
    // Without this, a restore done in the Gmail app leaves the stamp, and the
    // sweep destroys the only copy of a LIVE email at day 180.
    expect(binStateDrift([{ messageId: "m1", labelIds: ["INBOX"], deletedAt: ago(10) }]))
      .toEqual({ toBin: [], toRestore: ["m1"] })
  })

  it("writes nothing when every copy already agrees with Gmail", () => {
    expect(binStateDrift([
      { messageId: "live", labelIds: ["INBOX"], deletedAt: null },
      { messageId: "binned", labelIds: ["TRASH"], deletedAt: ago(3) },
    ])).toEqual({ toBin: [], toRestore: [] })
  })

  it("treats a missing label list as not-trashed", () => {
    expect(binStateDrift([{ messageId: "m1", labelIds: null, deletedAt: null }]))
      .toEqual({ toBin: [], toRestore: [] })
  })

  it("sorts a mixed batch into both directions at once", () => {
    const drift = binStateDrift([
      { messageId: "a", labelIds: ["TRASH"], deletedAt: null },
      { messageId: "b", labelIds: ["INBOX", "UNREAD"], deletedAt: ago(1) },
      { messageId: "c", labelIds: ["TRASH"], deletedAt: ago(1) },
    ])
    expect(drift).toEqual({ toBin: ["a"], toRestore: ["b"] })
  })
})

describe("objectsToPurge", () => {
  it("collects the body and every attachment", () => {
    expect(objectsToPurge({ bodyPath: "s/m/body.html", attachmentPaths: ["s/m/att/a", "s/m/att/b"] }))
      .toEqual(["s/m/body.html", "s/m/att/a", "s/m/att/b"])
  })

  it("includes bytes the DB has NO pointer to", () => {
    // An interrupted capture uploads body.html and then fails, so markError
    // writes body_path NULL. Purging only recorded paths would strand that PII.
    expect(objectsToPurge({ bodyPath: null, attachmentPaths: [], listedPaths: ["s/m/body.html"] }))
      .toEqual(["s/m/body.html"])
  })

  it("skips missing paths and de-duplicates across both sources", () => {
    expect(objectsToPurge({
      bodyPath: "s/m/body.html",
      attachmentPaths: ["s/m/att/a", null],
      listedPaths: ["s/m/body.html", "s/m/att/a", ""],
    })).toEqual(["s/m/body.html", "s/m/att/a"])
  })

  it("returns nothing when there is nothing stored", () => {
    expect(objectsToPurge({ bodyPath: null, attachmentPaths: [] })).toEqual([])
  })
})

type Opts = { failObjectsFor?: string; restoredMidSweep?: string; listed?: Record<string, string[]> }

function io(expired: ExpiredItem[], opts: Opts = {}) {
  const order: string[] = []
  const rowsRemoved: string[] = []
  const objectsRemoved: string[] = []
  const impl: PurgeIO = {
    listExpired: async () => expired,
    currentDeletedAt: async (_mb, id) =>
      id === opts.restoredMidSweep ? null : (expired.find((e) => e.messageId === id)?.deletedAt ?? null),
    listObjects: async (_mb, id) => opts.listed?.[id] ?? [],
    recordedPaths: async (_mb, id) => {
      const e = expired.find((x) => x.messageId === id)
      return { bodyPath: e?.bodyPath ?? null, attachmentPaths: e?.attachmentPaths ?? [] }
    },
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

const item = (id: string, deletedAt = ago(200), bodyPath: string | null = `s/${id}/body.html`): ExpiredItem =>
  ({ mailbox: "support", messageId: id, deletedAt, bodyPath, attachmentPaths: [] })

describe("purgeExpired", () => {
  it("removes storage BEFORE the rows (never strand bytes)", async () => {
    const h = io([{ ...item("m1"), attachmentPaths: ["s/m1/att/a"] }])
    const tally = await purgeExpired(NOW, h.impl)
    expect(h.order).toEqual(["objects", "rows"])
    expect(tally).toEqual({ examined: 1, purged: 1, objectsRemoved: 2, restored: 0, errors: 0 })
  })

  it("SKIPS a message restored after the batch was read (TOCTOU)", async () => {
    // The sweep reads 200 rows, then works through them. A staff restore landing
    // mid-run must not have its only copy destroyed on a stale snapshot.
    const h = io([item("m1")], { restoredMidSweep: "m1" })
    const tally = await purgeExpired(NOW, h.impl)
    expect(h.rowsRemoved).toEqual([])
    expect(h.objectsRemoved).toEqual([])
    expect(tally).toMatchObject({ purged: 0, restored: 1, errors: 0 })
  })

  it("purges bytes that no row points at", async () => {
    const h = io([item("m1", ago(200), null)], { listed: { m1: ["support/m1/body.html"] } })
    const tally = await purgeExpired(NOW, h.impl)
    expect(h.objectsRemoved).toEqual(["support/m1/body.html"])
    expect(tally.purged).toBe(1)
  })

  it("keeps the rows when storage removal fails, so the sweep can retry", async () => {
    const h = io([item("m1")], { failObjectsFor: "m1" })
    const tally = await purgeExpired(NOW, h.impl)
    expect(h.rowsRemoved).toEqual([])       // rows survive → retried next sweep
    expect(tally).toMatchObject({ purged: 0, errors: 1 })
  })

  it("one failure does not stop the rest of the batch", async () => {
    const h = io([item("bad"), item("good")], { failObjectsFor: "bad" })
    const tally = await purgeExpired(NOW, h.impl)
    expect(h.rowsRemoved).toEqual(["good"])
    expect(tally).toMatchObject({ examined: 2, purged: 1, errors: 1 })
  })

  it("still removes the rows when a message has no stored objects", async () => {
    const h = io([item("m2", ago(200), null)])
    const tally = await purgeExpired(NOW, h.impl)
    expect(h.rowsRemoved).toEqual(["m2"])
    expect(tally).toMatchObject({ objectsRemoved: 0, purged: 1 })
  })

  it("does nothing when nothing has expired", async () => {
    const h = io([])
    expect(await purgeExpired(NOW, h.impl)).toEqual({
      examined: 0, purged: 0, objectsRemoved: 0, restored: 0, errors: 0,
    })
  })
})

describe("purgeMessagesNow — 'delete forever' erases immediately", () => {
  it("destroys the named messages without waiting for the nightly sweep", async () => {
    // The user is told the email is gone, so it has to be gone — not gone tomorrow.
    const h = io([], { listed: { m1: ["support/m1/body.html"] } })
    const tally = await purgeMessagesNow("support", ["m1"], h.impl)
    expect(h.order).toEqual(["objects", "rows"])
    expect(h.rowsRemoved).toEqual(["m1"])
    expect(tally).toMatchObject({ examined: 1, purged: 1, errors: 0 })
  })

  it("counts a failure instead of throwing, so one bad message doesn't hide the rest", async () => {
    const h = io([], { failObjectsFor: "bad", listed: { bad: ["support/bad/body.html"] } })
    const tally = await purgeMessagesNow("support", ["bad"], h.impl)
    expect(h.rowsRemoved).toEqual([])
    expect(tally).toMatchObject({ purged: 0, errors: 1 })
  })

  it("refuses an unknown mailbox rather than guessing", async () => {
    await expect(purgeMessagesNow("nope" as never, ["m1"])).rejects.toThrow(/unknown mailbox/)
  })
})
