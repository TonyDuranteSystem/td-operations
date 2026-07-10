import { describe, it, expect, vi } from "vitest"
import {
  sniffImageMediaType,
  buildImageBlock,
  mimeFromFileName,
  readAttachmentBuffer,
  readAttachments,
  attachmentRefsFromChatRow,
  isMediaError,
  fetchTrustedStorageBytes,
  MAX_IMAGE_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_TURN,
  MAX_PDF_DOCUMENT_BLOCKS,
  type AttachmentRef,
} from "@/lib/ai-agent/attachment-reader"

// ── Fixtures ─────────────────────────────────────────────────────────────────
const png = (extra = 0) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), Buffer.alloc(extra)])
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)])
const gif = () => Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(16)])
const webp = () => Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP", "ascii"), Buffer.alloc(8)])
/** What Slack/an expired signed URL returns instead of the file: an HTML login page, HTTP 200. */
const htmlLoginPage = () => Buffer.from("<!DOCTYPE html><html><body>Sign in</body></html>", "utf8")

describe("sniffImageMediaType", () => {
  it("identifies each supported image from its magic bytes", () => {
    expect(sniffImageMediaType(png())).toBe("image/png")
    expect(sniffImageMediaType(jpeg())).toBe("image/jpeg")
    expect(sniffImageMediaType(gif())).toBe("image/gif")
    expect(sniffImageMediaType(webp())).toBe("image/webp")
  })

  it("rejects an HTML login page masquerading as an image (the files:read regression)", () => {
    expect(sniffImageMediaType(htmlLoginPage())).toBeNull()
  })

  it("rejects buffers too short to identify", () => {
    expect(sniffImageMediaType(Buffer.from([0x89, 0x50]))).toBeNull()
    expect(sniffImageMediaType(Buffer.alloc(0))).toBeNull()
  })
})

describe("buildImageBlock", () => {
  it("builds a base64 block with the SNIFFED media type", () => {
    const block = buildImageBlock(png())
    expect(block).not.toBeNull()
    expect(block!.type).toBe("image")
    expect(block!.source.media_type).toBe("image/png")
    expect(block!.source.data).toBe(png().toString("base64"))
  })

  it("returns null for non-images rather than sending garbage to the API", () => {
    expect(buildImageBlock(htmlLoginPage())).toBeNull()
  })

  it("returns null for an image over the per-image ceiling", () => {
    expect(buildImageBlock(png(MAX_IMAGE_BYTES))).toBeNull()
  })
})

describe("mimeFromFileName", () => {
  it("maps known extensions, case-insensitively", () => {
    expect(mimeFromFileName("a.PDF")).toBe("application/pdf")
    expect(mimeFromFileName("b.csv")).toBe("text/csv")
    expect(mimeFromFileName("c.xlsx")).toContain("spreadsheetml")
    expect(mimeFromFileName("d.png")).toBe("image/png")
  })

  it("falls back to octet-stream for unknown or missing names", () => {
    expect(mimeFromFileName("x.weird")).toBe("application/octet-stream")
    expect(mimeFromFileName(undefined)).toBe("application/octet-stream")
  })
})

describe("readAttachmentBuffer", () => {
  it("reads a real image into an image block", async () => {
    const out = await readAttachmentBuffer(png(), { id: "u", name: "shot.png", mimetype: "image/png" })
    expect(out.kind).toBe("image")
  })

  it("trusts the BYTES over the declared mimetype (declared image, actually HTML)", async () => {
    const out = await readAttachmentBuffer(htmlLoginPage(), { id: "u", name: "shot.png", mimetype: "image/png" })
    expect(out.kind).toBe("error")
    expect(out.kind === "error" && out.note).toMatch(/aren't a readable one/)
  })

  it("trusts the BYTES over the declared mimetype (declared pdf, actually a PNG)", async () => {
    const out = await readAttachmentBuffer(png(), { id: "u", name: "invoice.pdf", mimetype: "application/pdf" })
    expect(out.kind).toBe("image")
  })

  it("extracts text from a plain-text file", async () => {
    const out = await readAttachmentBuffer(Buffer.from("hello,world\n1,2", "utf8"), { id: "u", name: "d.csv", mimetype: "text/csv" })
    expect(out.kind).toBe("text")
    expect(out.kind === "text" && out.text).toContain("hello,world")
    expect(out.kind === "text" && out.text).toContain('"d.csv"')
  })

  it("notes an empty file rather than returning nothing", async () => {
    const out = await readAttachmentBuffer(Buffer.alloc(0), { id: "u", name: "e.txt", mimetype: "text/plain" })
    expect(out.kind).toBe("text")
    expect(out.kind === "text" && out.text).toContain("(empty file)")
  })

  it("refuses an unsupported file type with an honest note", async () => {
    const out = await readAttachmentBuffer(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]), {
      id: "u",
      name: "thing.exe",
      mimetype: "application/x-msdownload",
    })
    expect(out.kind).toBe("error")
    expect(out.kind === "error" && out.note).toMatch(/can't read this file type/)
  })

  it("refuses a file over the absolute byte ceiling", async () => {
    const out = await readAttachmentBuffer(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), { id: "u", name: "big.csv" })
    expect(out.kind).toBe("error")
    expect(out.kind === "error" && out.note).toMatch(/too large to read/)
  })

  it("refuses an oversized image with an image-specific note", async () => {
    const out = await readAttachmentBuffer(png(MAX_IMAGE_BYTES), { id: "u", name: "huge.png" })
    expect(out.kind).toBe("error")
    expect(out.kind === "error" && out.note).toMatch(/too large to look at/)
  })

  it("falls back to a native document block for a PDF with no text layer", async () => {
    // Not a parseable PDF → extractTextFromBuffer throws → scanned path.
    const out = await readAttachmentBuffer(Buffer.from("%PDF-1.4 not really a pdf", "utf8"), {
      id: "u",
      name: "scan.pdf",
      mimetype: "application/pdf",
    })
    expect(out.kind).toBe("document")
    expect(out.kind === "document" && out.documentBlock.source.media_type).toBe("application/pdf")
    expect(out.kind === "document" && out.note).toMatch(/no text layer/)
  })

  it("reports a scanned PDF as 'scanned', not 'error', when the caller can't take a document block", async () => {
    const out = await readAttachmentBuffer(
      Buffer.from("%PDF-1.4 not really a pdf", "utf8"),
      { id: "u", name: "scan.pdf", mimetype: "application/pdf" },
      false,
    )
    // Distinct from `error`: the file is fine, there's just no text to extract.
    expect(out.kind).toBe("scanned")
    expect(out.kind === "scanned" && out.note).toMatch(/no text layer/)
  })
})

describe("readAttachments", () => {
  const fetchOk = (buf: Buffer) => vi.fn(async () => buf)

  it("sorts results into image / document / text buckets", async () => {
    const refs: AttachmentRef[] = [
      { id: "1", name: "a.png" },
      { id: "2", name: "b.csv" },
    ]
    const out = await readAttachments(refs, async (r) => (r.id === "1" ? png() : Buffer.from("x,y", "utf8")))
    expect(out.imageBlocks).toHaveLength(1)
    expect(out.documentBlocks).toHaveLength(0)
    // one note for the image + one extracted-text block
    expect(out.textBlocks.some((t) => t.includes("shown to you above"))).toBe(true)
    expect(out.textBlocks.some((t) => t.includes("x,y"))).toBe(true)
  })

  it("returns empty for no refs without calling the fetcher", async () => {
    const fetcher = fetchOk(png())
    const out = await readAttachments([], fetcher)
    expect(out).toEqual({ textBlocks: [], imageBlocks: [], documentBlocks: [] })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("caps the number of files read and SAYS SO (never silently truncates)", async () => {
    const refs = Array.from({ length: MAX_ATTACHMENTS_PER_TURN + 3 }, (_, i) => ({ id: String(i), name: `f${i}.png` }))
    const out = await readAttachments(refs, async () => png())
    expect(out.imageBlocks).toHaveLength(MAX_ATTACHMENTS_PER_TURN)
    expect(out.textBlocks[0]).toMatch(/only the first 5 were read/)
  })

  it("caps native document blocks but keeps reading the rest", async () => {
    const refs = Array.from({ length: MAX_PDF_DOCUMENT_BLOCKS + 1 }, (_, i) => ({ id: String(i), name: `s${i}.pdf`, mimetype: "application/pdf" }))
    const out = await readAttachments(refs, async () => Buffer.from("%PDF-1.4 nope", "utf8"))
    expect(out.documentBlocks).toHaveLength(MAX_PDF_DOCUMENT_BLOCKS)
    expect(out.textBlocks.some((t) => /scanned-PDF limit \(2\) for this message was reached/.test(t))).toBe(true)
  })

  it("skips an oversized file by its DECLARED size without downloading it", async () => {
    const fetcher = vi.fn(async () => png())
    const out = await readAttachments([{ id: "1", name: "big.zip", size: MAX_ATTACHMENT_BYTES + 1 }], fetcher)
    expect(fetcher).not.toHaveBeenCalled()
    expect(out.textBlocks[0]).toMatch(/too large to read/)
  })

  it("turns a download failure into a note and keeps reading the others", async () => {
    const out = await readAttachments(
      [
        { id: "bad", name: "a.png" },
        { id: "good", name: "b.png" },
      ],
      async (r) => {
        if (r.id === "bad") throw new Error("HTTP 403")
        return png()
      },
    )
    expect(out.imageBlocks).toHaveLength(1)
    expect(out.textBlocks.some((t) => t.includes("HTTP 403"))).toBe(true)
  })
})

describe("attachmentRefsFromChatRow", () => {
  it("reads the modern attachments array", () => {
    const refs = attachmentRefsFromChatRow({
      attachments: [{ url: "https://s/a.png", name: "a.png", mime_type: "image/png", size: 12 }],
    })
    expect(refs).toEqual([{ id: "https://s/a.png", name: "a.png", mimetype: "image/png", size: 12 }])
  })

  it("falls back to the legacy single-attachment columns", () => {
    const refs = attachmentRefsFromChatRow({ attachments: [], attachment_url: "https://s/b.pdf", attachment_name: "b.pdf" })
    expect(refs).toEqual([{ id: "https://s/b.pdf", name: "b.pdf" }])
  })

  it("names a legacy attachment 'file' when the name column is null", () => {
    expect(attachmentRefsFromChatRow({ attachment_url: "https://s/x", attachment_name: null })[0].name).toBe("file")
  })

  it("survives malformed jsonb instead of throwing (the column is untyped)", () => {
    expect(attachmentRefsFromChatRow({ attachments: "not an array" })).toEqual([])
    expect(attachmentRefsFromChatRow({ attachments: [null, 42, "x"] })).toEqual([])
    expect(attachmentRefsFromChatRow({ attachments: [{ name: "no url" }] })).toEqual([])
    expect(attachmentRefsFromChatRow({})).toEqual([])
  })

  it("drops only the invalid entries, keeping the good ones", () => {
    const refs = attachmentRefsFromChatRow({ attachments: [{ name: "bad" }, { url: "https://s/ok.png", name: "ok.png" }] })
    expect(refs).toHaveLength(1)
    expect(refs[0].id).toBe("https://s/ok.png")
  })

  it("ignores non-string name/mime/size rather than passing junk downstream", () => {
    const refs = attachmentRefsFromChatRow({ attachments: [{ url: "https://s/a", name: 5, mime_type: {}, size: "big" }] })
    expect(refs[0]).toEqual({ id: "https://s/a", name: undefined, mimetype: undefined, size: undefined })
  })
})

describe("isMediaError", () => {
  it("is true only for a 400 that names the media, and only when media was sent", () => {
    const mediaErr = new Error("400 invalid_request_error: could not process image")
    expect(isMediaError(mediaErr, true)).toBe(true)
    expect(isMediaError(mediaErr, false)).toBe(false)
  })

  it("is false for unrelated failures — a real bug must never be downgraded", () => {
    expect(isMediaError(new Error("500 internal server error"), true)).toBe(false)
    expect(isMediaError(new Error("400 invalid_request_error: max_tokens too large"), true)).toBe(false)
    expect(isMediaError(new Error("rate_limit_error"), true)).toBe(false)
  })

  it("handles non-Error throws", () => {
    expect(isMediaError("400 bad image", true)).toBe(true)
  })
})

describe("callWorkerWithAttachments", () => {
  const png1 = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "x" } }

  it("passes options straight through on success", async () => {
    const callWorker = vi.fn(async () => ({ reply: "ok", toolsUsed: [] }))
    vi.doMock("@/lib/ai-agent/worker-tools", () => ({ callWorker }))
    vi.resetModules()
    const { callWorkerWithAttachments } = await import("@/lib/ai-agent/attachment-reader")

    const res = await callWorkerWithAttachments("hi", { images: [png1], enableDbRead: true })
    expect(res.reply).toBe("ok")
    expect(callWorker).toHaveBeenCalledTimes(1)
    vi.doUnmock("@/lib/ai-agent/worker-tools")
  })

  it("retries WITHOUT media on a media 400, keeping every other option", async () => {
    const callWorker = vi
      .fn()
      .mockRejectedValueOnce(new Error("400 could not process image"))
      .mockResolvedValueOnce({ reply: "text answer", toolsUsed: [] })
    vi.doMock("@/lib/ai-agent/worker-tools", () => ({ callWorker }))
    vi.resetModules()
    const { callWorkerWithAttachments } = await import("@/lib/ai-agent/attachment-reader")

    const res = await callWorkerWithAttachments("hi", { images: [png1], enableDbRead: true, maxIterations: 7 })
    expect(res.reply).toBe("text answer")
    expect(callWorker).toHaveBeenCalledTimes(2)

    const retryOpts = callWorker.mock.calls[1][1]
    expect(retryOpts.images).toBeUndefined()
    expect(retryOpts.documents).toBeUndefined()
    // every other flag survives the retry — the bug the Slack hand-rebuild invites
    expect(retryOpts.enableDbRead).toBe(true)
    expect(retryOpts.maxIterations).toBe(7)
    // the model is told the file is missing, so it says so instead of guessing
    expect(callWorker.mock.calls[1][0]).toMatch(/could not be processed/)
    vi.doUnmock("@/lib/ai-agent/worker-tools")
  })

  it("re-throws a non-media error instead of retrying", async () => {
    const callWorker = vi.fn().mockRejectedValue(new Error("500 boom"))
    vi.doMock("@/lib/ai-agent/worker-tools", () => ({ callWorker }))
    vi.resetModules()
    const { callWorkerWithAttachments } = await import("@/lib/ai-agent/attachment-reader")

    await expect(callWorkerWithAttachments("hi", { images: [png1] })).rejects.toThrow(/500 boom/)
    expect(callWorker).toHaveBeenCalledTimes(1)
    vi.doUnmock("@/lib/ai-agent/worker-tools")
  })

  it("does not retry a media-shaped error when no media was attached", async () => {
    const callWorker = vi.fn().mockRejectedValue(new Error("400 image"))
    vi.doMock("@/lib/ai-agent/worker-tools", () => ({ callWorker }))
    vi.resetModules()
    const { callWorkerWithAttachments } = await import("@/lib/ai-agent/attachment-reader")

    await expect(callWorkerWithAttachments("hi", {})).rejects.toThrow(/400 image/)
    expect(callWorker).toHaveBeenCalledTimes(1)
    vi.doUnmock("@/lib/ai-agent/worker-tools")
  })
})

describe("fetchTrustedStorageBytes", () => {
  it("refuses a host outside the allow-list (SSRF guard)", async () => {
    await expect(fetchTrustedStorageBytes({ id: "https://evil.example.com/x.png" })).rejects.toThrow(/untrusted host/)
  })

  it("refuses an unparseable URL", async () => {
    await expect(fetchTrustedStorageBytes({ id: "not a url" })).rejects.toThrow(/invalid URL/)
  })

  it("refuses a lookalike host that merely contains a trusted one", async () => {
    await expect(
      fetchTrustedStorageBytes({ id: "https://ydzipybqeebtpcvsbtvs.supabase.co.evil.com/x.png" }),
    ).rejects.toThrow(/untrusted host/)
  })

  it("downloads from a trusted host", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(png(), { status: 200 }) as unknown as Response,
    )
    const buf = await fetchTrustedStorageBytes({ id: "https://xjcxlmlpeywtwkhstjlw.supabase.co/storage/v1/object/public/assets/a.png" })
    expect(sniffImageMediaType(buf)).toBe("image/png")
    spy.mockRestore()
  })

  it("surfaces a non-200 as an error the caller can report", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }) as unknown as Response)
    await expect(
      fetchTrustedStorageBytes({ id: "https://xjcxlmlpeywtwkhstjlw.supabase.co/storage/v1/object/public/assets/a.png" }),
    ).rejects.toThrow(/HTTP 404/)
    spy.mockRestore()
  })
})
