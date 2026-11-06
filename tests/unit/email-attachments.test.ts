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
  referencedContentIds,
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
/**
 * A photo attached the ordinary way in Gmail. Gmail stamps a Content-ID
 * (`f_xxxx`) on these too, but the HTML body never references it.
 */
function gmailAttachedPhoto(filename: string, size: number, attachmentId: string) {
  return {
    filename,
    mimeType: "image/jpeg",
    headers: [{ name: "Content-ID", value: `<f_${attachmentId}>` }],
    body: { size, attachmentId },
  }
}
/** A text/html part carrying the given markup, delivered inline the way Gmail does for normal-size bodies. */
function htmlPart(html: string) {
  return { mimeType: "text/html", body: { data: Buffer.from(html).toString("base64url") } }
}
type AnyPart =
  | ReturnType<typeof part>
  | ReturnType<typeof inlinePart>
  | ReturnType<typeof gmailAttachedPhoto>
  | ReturnType<typeof htmlPart>
  | { mimeType: string; body: { attachmentId: string } }
function msg(id: string, parts: AnyPart[]): GmailAPIMessage {
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

  it("EXCLUDES images the body displays — the signature logos every corporate footer carries", async () => {
    const out = await harvestEmailAttachments(
      [
        msg("m1", [
          htmlPart('<p>Thanks</p><img src="cid:cid1@mail">'),
          inlinePart("logo.png", 60_000, "cid1"),
          part("shot.png", "image/png", 50_000, "a1"),
        ]),
      ],
      MAILBOX,
    )
    // The logo is 60KB — well over the size filter. The body displaying it is what excludes it.
    expect(out.imageBlocks).toHaveLength(1)
    expect(out.note).toContain("shot.png")
    expect(out.note).not.toContain("logo.png")
  })

  it("regression (Prime Circle, 2026-11-06): READS a photo the client ATTACHED in Gmail — it carries a Content-ID (f_) the body never references", async () => {
    const out = await harvestEmailAttachments(
      [msg("m1", [htmlPart("<div>Kindly find attached a picture</div>"), gmailAttachedPhoto("WhatsApp Image.jpeg", 103_204, "att1")])],
      MAILBOX,
    )
    expect(out.imageBlocks).toHaveLength(1)
    expect(getGmailAttachment).toHaveBeenCalledTimes(1)
    expect(out.note).toContain("WhatsApp Image.jpeg")
  })

  it("reads the attached photo but still skips the logo when one message has both", async () => {
    const out = await harvestEmailAttachments(
      [
        msg("m1", [
          htmlPart('<img src="cid:logo1@mail"><p>see attached</p>'),
          inlinePart("logo.png", 60_000, "logo1"),
          gmailAttachedPhoto("passport.jpg", 200_000, "att1"),
        ]),
      ],
      MAILBOX,
    )
    expect(out.imageBlocks).toHaveLength(1)
    expect(out.note).toContain("passport.jpg")
    expect(out.note).not.toContain("logo.png")
  })

  it("recognises logos carried only by the HTML ALTERNATIVE of a plain-text-first email", async () => {
    const out = await harvestEmailAttachments(
      [
        {
          id: "m1",
          payload: {
            headers: [],
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: Buffer.from("hello").toString("base64url") } },
              {
                mimeType: "multipart/related",
                parts: [
                  htmlPart('<img src="cid:logo1@mail">'),
                  inlinePart("logo.png", 60_000, "logo1"),
                ],
              },
            ],
          },
        } as unknown as GmailAPIMessage,
      ],
      MAILBOX,
    )
    expect(out.imageBlocks).toHaveLength(0)
    expect(getGmailAttachment).not.toHaveBeenCalled()
  })

  it("reads a Content-ID image on an email with NO html part — nothing displays it, so it is a real attachment", async () => {
    const out = await harvestEmailAttachments(
      [msg("m1", [inlinePart("scan.png", 60_000, "cid9")])],
      MAILBOX,
    )
    expect(out.imageBlocks).toHaveLength(1)
    expect(out.note).toContain("scan.png")
  })

  it("stays SAFE when an HTML part was not delivered inline — cannot tell what the body shows, so every Content-ID image is still treated as embedded", async () => {
    const out = await harvestEmailAttachments(
      [
        msg("m1", [
          { mimeType: "text/html", body: { attachmentId: "html-too-big" } },
          inlinePart("logo.png", 60_000, "cid1"),
          gmailAttachedPhoto("photo.jpg", 120_000, "att1"),
        ]),
      ],
      MAILBOX,
    )
    expect(out.imageBlocks).toHaveLength(0)
    expect(getGmailAttachment).not.toHaveBeenCalled()
  })

  it("still skips a tiny attached image — the size floor is untouched", async () => {
    const out = await harvestEmailAttachments(
      [msg("m1", [htmlPart("<p>x</p>"), gmailAttachedPhoto("pixel.jpg", MIN_MEANINGFUL_IMAGE_BYTES - 1, "att1")])],
      MAILBOX,
    )
    expect(out.imageBlocks).toHaveLength(0)
    expect(getGmailAttachment).not.toHaveBeenCalled()
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

describe("referencedContentIds", () => {
  const payloadOf = (parts: AnyPart[]) => ({ headers: [], mimeType: "multipart/related", parts }) as GmailAPIMessage["payload"]

  it("collects every cid the HTML displays — quoted, single-quoted and unquoted", () => {
    const html = '<img src="cid:a@x"><img src=\'cid:b@x\'><img src=cid:c@x>'
    const { cids, complete } = referencedContentIds(payloadOf([htmlPart(html)]))
    expect([...cids].sort()).toEqual(["a@x", "b@x", "c@x"])
    expect(complete).toBe(true)
  })

  it("finds cids in a nested multipart and in a single-part HTML message", () => {
    const nested = {
      headers: [],
      mimeType: "multipart/mixed",
      parts: [{ mimeType: "multipart/alternative", parts: [htmlPart('<img src="cid:deep@x">')] }],
    } as unknown as GmailAPIMessage["payload"]
    expect([...referencedContentIds(nested).cids]).toEqual(["deep@x"])

    const single = {
      headers: [],
      mimeType: "text/html",
      body: { data: Buffer.from('<img src="cid:solo@x">').toString("base64url") },
    } as unknown as GmailAPIMessage["payload"]
    expect([...referencedContentIds(single).cids]).toEqual(["solo@x"])
  })

  it("returns nothing for a plain-text message or a payload with no parts", () => {
    expect(referencedContentIds(payloadOf([])).cids.size).toBe(0)
    const text = { headers: [], mimeType: "text/plain", body: { data: Buffer.from("cid:not-a-reference").toString("base64url") } }
    const r = referencedContentIds(text as unknown as GmailAPIMessage["payload"])
    expect(r.cids.size).toBe(0)
    expect(r.complete).toBe(true)
  })

  it("is incomplete when an HTML part has only an attachmentId (body too large to inline)", () => {
    const r = referencedContentIds(payloadOf([{ mimeType: "text/html", body: { attachmentId: "big" } }]))
    expect(r.complete).toBe(false)
  })

  it("does not count a cid mentioned in visible text — only src= references", () => {
    const r = referencedContentIds(payloadOf([htmlPart("<p>see cid:f_abc for details</p>")]))
    expect(r.cids.size).toBe(0)
  })
})
