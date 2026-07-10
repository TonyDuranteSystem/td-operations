import { describe, it, expect, vi, beforeEach } from "vitest"

// Only the network call is mocked. extractAttachments — the part that decides
// what IS an attachment — runs for real, which is the whole point of the test.
const { getGmailAttachment } = vi.hoisted(() => ({ getGmailAttachment: vi.fn() }))
vi.mock("@/lib/gmail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gmail")>()
  return { ...actual, getGmailAttachment }
})

import {
  harvestEmailAttachments,
  MIN_MEANINGFUL_IMAGE_BYTES,
  MAX_EMAIL_IMAGES,
  MAX_EMAIL_DOCUMENTS,
  MAX_EMAIL_ATTACHMENTS_SCANNED,
  attachmentRef,
} from "@/lib/inbox/email-attachments"
import type { GmailAPIMessage } from "@/lib/gmail"

const png = (bytes = 64) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), Buffer.alloc(bytes)])

/** A Gmail message payload part that extractAttachments will pick up. */
function part(filename: string, mimeType: string, size: number, attachmentId: string) {
  return { filename, mimeType, body: { size, attachmentId } }
}
/** An INLINE part — a signature logo the email body references with cid:. */
function inlinePart(filename: string, size: number, attachmentId: string) {
  return {
    filename,
    mimeType: "image/png",
    headers: [{ name: "Content-ID", value: `<${attachmentId}@mail>` }],
    body: { size, attachmentId },
  }
}
function msg(id: string, parts: Array<ReturnType<typeof part> | ReturnType<typeof inlinePart>>): GmailAPIMessage {
  return { id, payload: { headers: [], parts } } as unknown as GmailAPIMessage
}

const MAILBOX = "support@tonydurante.us"

beforeEach(() => {
  getGmailAttachment.mockReset()
  getGmailAttachment.mockResolvedValue({ data: png(), size: 76 })
})

describe("harvestEmailAttachments", () => {
  it("attaches images and only LISTS documents (no upfront download of a 40-page PDF)", async () => {
    const out = await harvestEmailAttachments(
      [msg("m1", [part("shot.png", "image/png", 50_000, "a1"), part("contract.pdf", "application/pdf", 900_000, "a2")])],
      MAILBOX,
    )
    expect(out.imageBlocks).toHaveLength(1)
    expect(out.pinned).toHaveLength(1)
    expect(out.pinned[0]).toMatchObject({ ref: attachmentRef("a2"), name: "contract.pdf", mailbox: MAILBOX, messageId: "m1" })
    // the PDF was never fetched
    expect(getGmailAttachment).toHaveBeenCalledTimes(1)
    expect(out.note).toContain("shot.png")
    expect(out.note).toContain(`${attachmentRef("a2")} — contract.pdf`)
  })

  it("EXCLUDES inline images — the signature logos every corporate footer carries", async () => {
    const out = await harvestEmailAttachments(
      [msg("m1", [inlinePart("logo.png", 60_000, "cid1"), part("shot.png", "image/png", 50_000, "a1")])],
      MAILBOX,
    )
    // The logo is 60KB — well over the size filter. Only the Content-ID header saves us.
    expect(out.imageBlocks).toHaveLength(1)
    expect(out.note).toContain("shot.png")
    expect(out.note).not.toContain("logo.png")
  })

  it("walks messages NEWEST-first, so an old thread's logos can't crowd out today's screenshot", async () => {
    // Three big images on older messages would fill all 3 slots if walked oldest-first.
    const older = (n: string) => msg(n, [part(`old-${n}.png`, "image/png", 50_000, `old-${n}`)])
    const newest = msg("m4", [part("the-screenshot.png", "image/png", 50_000, "new1")])
    const out = await harvestEmailAttachments([older("m1"), older("m2"), older("m3"), newest], MAILBOX)
    expect(out.imageBlocks).toHaveLength(3)
    // the newest message's image is present, not starved
    expect(out.note).toContain("the-screenshot.png")
  })

  it("gives an attachment a ref derived from its identity, stable across turns", async () => {
    // The thread window shifts as new mail arrives; a positional att1 would then
    // point at a different file than the replayed transcript claims.
    const a = await harvestEmailAttachments([msg("m1", [part("x.pdf", "application/pdf", 10, "gmail-att-id-1")])], MAILBOX)
    const b = await harvestEmailAttachments(
      [msg("m0", [part("new.pdf", "application/pdf", 10, "zzz")]), msg("m1", [part("x.pdf", "application/pdf", 10, "gmail-att-id-1")])],
      MAILBOX,
    )
    const refOfX = (h: typeof a) => h.pinned.find((p) => p.name === "x.pdf")!.ref
    expect(refOfX(a)).toBe(refOfX(b))
    expect(refOfX(a)).toMatch(/^att_[0-9a-f]{8}$/)
  })

  it("skips a known-oversized image without spending the download", async () => {
    const out = await harvestEmailAttachments(
      [msg("m1", [part("huge.png", "image/png", 9 * 1024 * 1024, "a1")])],
      MAILBOX,
    )
    expect(getGmailAttachment).not.toHaveBeenCalled()
    expect(out.imageBlocks).toHaveLength(0)
    expect(out.note).toMatch(/huge\.png \(too large to look at\)/)
  })

  it("skips tiny inline images — signature logos and tracking pixels", async () => {
    const out = await harvestEmailAttachments(
      [msg("m1", [part("logo.png", "image/png", MIN_MEANINGFUL_IMAGE_BYTES - 1, "a1")])],
      MAILBOX,
    )
    expect(out.imageBlocks).toHaveLength(0)
    expect(getGmailAttachment).not.toHaveBeenCalled()
    expect(out.note).toBe("") // and doesn't clutter the prompt
  })

  it("still fetches an image whose size Gmail reports as 0", async () => {
    const out = await harvestEmailAttachments([msg("m1", [part("shot.png", "image/png", 0, "a1")])], MAILBOX)
    expect(out.imageBlocks).toHaveLength(1)
  })

  it("caps images and NAMES the ones it dropped", async () => {
    const parts = Array.from({ length: MAX_EMAIL_IMAGES + 2 }, (_, i) => part(`s${i}.png`, "image/png", 50_000, `a${i}`))
    const out = await harvestEmailAttachments([msg("m1", parts)], MAILBOX)
    expect(out.imageBlocks).toHaveLength(MAX_EMAIL_IMAGES)
    expect(out.note).toMatch(/Not available: s3\.png, s4\.png/)
    expect(out.note).toContain("Not available") // the drop is announced, never silent
  })

  it("caps documents and names the dropped ones", async () => {
    const parts = Array.from({ length: MAX_EMAIL_DOCUMENTS + 1 }, (_, i) => part(`d${i}.pdf`, "application/pdf", 1000, `a${i}`))
    const out = await harvestEmailAttachments([msg("m1", parts)], MAILBOX)
    expect(out.pinned).toHaveLength(MAX_EMAIL_DOCUMENTS)
    expect(out.note).toMatch(/Not available: d8\.pdf/)
  })

  it("stops scanning a message stuffed with attachments", async () => {
    const parts = Array.from({ length: MAX_EMAIL_ATTACHMENTS_SCANNED + 20 }, (_, i) =>
      part(`d${i}.pdf`, "application/pdf", 1000, `a${i}`),
    )
    const out = await harvestEmailAttachments([msg("m1", parts)], MAILBOX)
    expect(out.pinned).toHaveLength(MAX_EMAIL_DOCUMENTS)
  })

  it("stamps the SERVER's mailbox on every pinned ref (never caller input)", async () => {
    const out = await harvestEmailAttachments(
      [msg("m1", [part("a.pdf", "application/pdf", 10, "a1")]), msg("m2", [part("b.pdf", "application/pdf", 10, "a2")])],
      "antonio.durante@tonydurante.us",
    )
    expect(out.pinned.every((p) => p.mailbox === "antonio.durante@tonydurante.us")).toBe(true)
    // refs are unique across messages in the thread
    expect(new Set(out.pinned.map((p) => p.ref)).size).toBe(2)
  })

  it("survives an image download failure and says so", async () => {
    getGmailAttachment.mockRejectedValueOnce(new Error("Gmail attachment 403"))
    const out = await harvestEmailAttachments(
      [msg("m1", [part("shot.png", "image/png", 50_000, "a1"), part("ok.png", "image/png", 50_000, "a2")])],
      MAILBOX,
    )
    expect(out.imageBlocks).toHaveLength(1) // the second one still made it
    expect(out.note).toMatch(/shot\.png \(couldn't download\)/)
  })

  it("reports an image whose bytes aren't a real image", async () => {
    getGmailAttachment.mockResolvedValueOnce({ data: Buffer.from("<html>nope</html>"), size: 17 })
    const out = await harvestEmailAttachments([msg("m1", [part("fake.png", "image/png", 50_000, "a1")])], MAILBOX)
    expect(out.imageBlocks).toHaveLength(0)
    expect(out.note).toMatch(/not a readable image/)
  })

  it("returns nothing for a message with no attachments", async () => {
    const out = await harvestEmailAttachments([msg("m1", [])], MAILBOX)
    expect(out).toEqual({ imageBlocks: [], pinned: [], note: "" })
  })

  it("handles a message with no payload", async () => {
    const out = await harvestEmailAttachments([{ id: "m1" } as unknown as GmailAPIMessage], MAILBOX)
    expect(out.pinned).toHaveLength(0)
  })
})
