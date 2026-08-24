/**
 * A file pasted into chat is windowed with the SAME windowText() the 4
 * tool-based readers (read_uploaded_file etc.) use, but nothing ever told
 * read-completion.ts's ledger about it — so the model got no live "you're not
 * done reading" signal for a door-attached file, only the after-the-fact
 * disclaimer once the turn had already shipped (dev job 5e87b099).
 *
 * This proves the fix end-to-end: readAttachments() emits a {ref, resultText}
 * seed for a windowed door-attached file (matched to its short ref by ARRAY
 * POSITION, never by re-scanning combined text for marker lines — a hostile
 * file's own content could forge those to misattribute another file's state),
 * and seedPendingReadsFromDoorAttachments() feeds those seeds through
 * updatePendingReads()'s own, already-reviewed forgery defenses to populate
 * the SAME ledger a real read_uploaded_file continuation would advance.
 */

import { describe, it, expect } from "vitest"
import { readAttachments, type AttachmentRef } from "@/lib/ai-agent/attachment-reader"
import {
  type PendingRead,
  seedPendingReadsFromDoorAttachments,
  updatePendingReads,
  pendingReadKey,
} from "@/lib/ai-agent/read-completion"

const LONG_TEXT = "Row of data, comma, and stuff. ".repeat(1000) // well over the 20k window
const SHORT_TEXT = "A short note, nothing to page through."

function fetcherFor(byId: Record<string, string>) {
  return async (ref: AttachmentRef) => Buffer.from(byId[ref.id] ?? "", "utf8")
}

describe("readAttachments — door-attachment read seeds", () => {
  it("emits a seed for a windowed text file, keyed by its short ref", async () => {
    const refs: AttachmentRef[] = [{ id: "s1", name: "Tracking.csv", mimetype: "text/csv" }]
    const read = await readAttachments(refs, fetcherFor({ s1: LONG_TEXT }), ["up1"])
    expect(read.pendingReadSeeds).toHaveLength(1)
    expect(read.pendingReadSeeds[0].ref).toBe("up1")
    expect(read.pendingReadSeeds[0].resultText).toBe(read.textBlocks[0])
    expect(read.pendingReadSeeds[0].resultText).toMatch(/continue with offset: \d+\]$/m)
  })

  it("emits NO seed for a file with no shortRef offered (caller has no re-read pin for it)", async () => {
    const refs: AttachmentRef[] = [{ id: "s1", name: "Tracking.csv", mimetype: "text/csv" }]
    const read = await readAttachments(refs, fetcherFor({ s1: LONG_TEXT })) // shortRefs omitted
    expect(read.pendingReadSeeds).toEqual([])
  })

  it("matches multiple files by POSITION, not by name — two files can share a name safely", async () => {
    const refs: AttachmentRef[] = [
      { id: "s1", name: "report.csv", mimetype: "text/csv" },
      { id: "s2", name: "report.csv", mimetype: "text/csv" }, // same name, different file
    ]
    const read = await readAttachments(
      refs,
      fetcherFor({ s1: LONG_TEXT, s2: SHORT_TEXT }),
      ["up1", "up2"],
    )
    expect(read.pendingReadSeeds).toHaveLength(2)
    expect(read.pendingReadSeeds[0]).toMatchObject({ ref: "up1" })
    expect(read.pendingReadSeeds[1]).toMatchObject({ ref: "up2" })
    expect(read.pendingReadSeeds[0].resultText).not.toBe(read.pendingReadSeeds[1].resultText)
  })

  it("an image produces no seed — it was never windowed text", async () => {
    // A 1x1 PNG's magic bytes.
    const png = Buffer.from("89504e470d0a1a0a", "hex")
    const refs: AttachmentRef[] = [{ id: "img1", name: "shot.png", mimetype: "image/png" }]
    const read = await readAttachments(
      refs,
      async () => png,
      ["up1"],
    )
    expect(read.pendingReadSeeds).toEqual([])
  })
})

describe("seedPendingReadsFromDoorAttachments — ledger population", () => {
  it("populates the ledger for a genuinely truncated door-attached file", async () => {
    const refs: AttachmentRef[] = [{ id: "s1", name: "Tracking.csv", mimetype: "text/csv" }]
    const read = await readAttachments(refs, fetcherFor({ s1: LONG_TEXT }), ["up1"])

    const ledger = new Map<string, PendingRead>()
    seedPendingReadsFromDoorAttachments(ledger, read.pendingReadSeeds)

    const key = pendingReadKey("read_uploaded_file", { ref: "up1" })
    expect(ledger.has(key)).toBe(true)
    expect(ledger.get(key)!.nextOffset).toBeGreaterThan(0)
  })

  it("does NOT populate the ledger for a file that fit in one window — nothing to page through", async () => {
    const refs: AttachmentRef[] = [{ id: "s1", name: "note.txt", mimetype: "text/plain" }]
    const read = await readAttachments(refs, fetcherFor({ s1: SHORT_TEXT }), ["up1"])

    const ledger = new Map<string, PendingRead>()
    seedPendingReadsFromDoorAttachments(ledger, read.pendingReadSeeds)

    expect(ledger.size).toBe(0)
  })

  it("REGRESSION: a real continuation call for the SAME ref advances the SAME ledger entry the door-time seed created", async () => {
    // This is the exact wiring the fix depends on: the seed created at door-time
    // and a later, genuine read_uploaded_file({ref: 'up1', offset: N}) tool call
    // must land on the identical ledger key, or the model's continuation would
    // silently create a SECOND, orphaned entry instead of clearing the real one.
    const refs: AttachmentRef[] = [{ id: "s1", name: "Tracking.csv", mimetype: "text/csv" }]
    const read = await readAttachments(refs, fetcherFor({ s1: LONG_TEXT }), ["up1"])

    const ledger = new Map<string, PendingRead>()
    seedPendingReadsFromDoorAttachments(ledger, read.pendingReadSeeds)
    const key = pendingReadKey("read_uploaded_file", { ref: "up1" })
    const seededOffset = ledger.get(key)!.nextOffset
    expect(ledger.size).toBe(1)

    // Simulate the model's real continuation call landing on the exact offset
    // the seed reported, reading to the very end this time.
    const rest = LONG_TEXT.slice(seededOffset)
    const endMarker = `\n[end of file — ${LONG_TEXT.length} chars total]`
    updatePendingReads(ledger, "read_uploaded_file", { ref: "up1", offset: seededOffset }, rest + endMarker)

    expect(ledger.size).toBe(0) // cleared — the SAME entry the seed created, not a duplicate
  })
})
