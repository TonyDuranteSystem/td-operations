import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "fs"
import { looksLikeHeic, heicToJpeg, readStoreFileContent, type ReadDeps } from "@/lib/crm-store/read-content"
import type { OcrResult } from "@/lib/docai"

const ocr = (text: string, pages?: string[]): OcrResult => ({ fullText: text, pages: pages ?? [text], pageCount: (pages ?? [text]).length, fileName: "x", mimeType: "application/pdf", confidence: 0.97 })

function deps(file: { bytes: Buffer; mimeType: string | null; name: string }, text: string): { d: ReadDeps; ocrBytes: ReturnType<typeof vi.fn>; toJpeg: ReturnType<typeof vi.fn> } {
  const ocrBytes = vi.fn(async () => ocr(text))
  const toJpeg = vi.fn(async (b: Buffer) => Buffer.from("JPEG" + b.length))
  return { d: { readStore: async () => file, ocrBytes, toJpeg }, ocrBytes, toJpeg }
}

describe("HEIC detection and conversion", () => {
  const heic = readFileSync("tests/fixtures/tiny.heic")
  it("recognises a HEIC by mime type, extension and file signature — whatever the file is called", () => {
    expect(looksLikeHeic("a.bin", "image/heif", Buffer.alloc(4))).toBe(true)
    expect(looksLikeHeic("Paasaporto.HEIC", null, Buffer.alloc(4))).toBe(true)
    expect(looksLikeHeic("Unclassified - x", "application/octet-stream", heic)).toBe(true)
    expect(looksLikeHeic("a.pdf", "application/pdf", Buffer.from("%PDF-1.7 ....."))).toBe(false)
  })
  it("really converts a HEIC photo to a JPEG", async () => {
    const jpg = await heicToJpeg(heic)
    expect(jpg.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true)
  })
})

describe("reading what a stored file is", () => {
  it("a PDF is read and typed from its words, not from its name", async () => {
    const { d } = deps({ bytes: Buffer.from("%PDF"), mimeType: "application/pdf", name: "Resolution - X.pdf" },
      "CERTIFICATE OF FORMATION OF Dieci Dieci Company LLC State of Delaware Secretary of State Division of Corporations FIRST: The name of the limited liability company is")
    const r = await readStoreFileContent("f1", d)
    expect(r.problem).toBeNull()
    expect(r.suggestedType).toBe("Articles of Organization")
    expect(r.converted).toBe(false)
  })
  it("a HEIC is converted first, then read as a JPEG", async () => {
    const { d, ocrBytes, toJpeg } = deps({ bytes: Buffer.from("....ftypheic...."), mimeType: "image/heif", name: "Unclassified.HEIC" }, "PASSPORT REPUBBLICA ITALIANA")
    const r = await readStoreFileContent("f2", d)
    expect(toJpeg).toHaveBeenCalledTimes(1)
    expect(ocrBytes.mock.calls[0][1]).toBe("image/jpeg")
    expect(r.converted).toBe(true)
    expect(r.suggestedType).toBe("Passport")
  })
  it("a file with no readable words says so instead of guessing", async () => {
    const { d } = deps({ bytes: Buffer.from("x"), mimeType: "image/png", name: "a.png" }, "   ")
    const r = await readStoreFileContent("f3", d)
    expect(r.suggestedType).toBeNull()
    expect(r.problem).toMatch(/No words/)
  })
  it("words that match no rule say so", async () => {
    const { d } = deps({ bytes: Buffer.from("x"), mimeType: "application/pdf", name: "a.pdf" }, "lorem ipsum dolor sit amet")
    expect((await readStoreFileContent("f4", d)).problem).toMatch(/do not match/)
  })
  it("a reader failure is reported on the file, never thrown", async () => {
    const d: ReadDeps = { readStore: async () => ({ bytes: Buffer.from("x"), mimeType: "application/pdf", name: "a.pdf" }), ocrBytes: async () => { throw new Error("Document AI down") }, toJpeg: async (b) => b }
    expect((await readStoreFileContent("f5", d)).problem).toBe("Document AI down")
  })
})
