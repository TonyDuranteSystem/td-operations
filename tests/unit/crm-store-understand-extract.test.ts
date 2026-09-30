import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "fs"
import JSZip from "jszip"
import { sniffKind, decodeText, looksLikeText } from "@/lib/crm-store/understand/sniff"
import { extractContent, guardZip, readZip, type ExtractDeps } from "@/lib/crm-store/understand/extract"
import { LIMITS } from "@/lib/crm-store/understand/vocab"

const heic = readFileSync("tests/fixtures/tiny.heic")
const deps = (over: Partial<ExtractDeps> = {}): ExtractDeps => ({
  ocr: vi.fn(async () => ({ fullText: "SCANNED WORDS here", pages: ["SCANNED WORDS here"], documentPageCount: 1, partial: false })),
  pdfTextLayer: vi.fn(async () => ({ text: "", numpages: 1 })),
  heicToJpeg: vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])),
  shrinkJpeg: vi.fn(async (b: Buffer) => b),
  officeText: vi.fn(async () => "sheet text"),
  ...over,
})

describe("the real kind of a file comes from its bytes, never its name", () => {
  it.each([
    ["pdf", Buffer.from("%PDF-1.7\n..."), "x.jpg"],
    ["jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "scan.pdf"],
    ["png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), "a.txt"],
    ["heic", heic, "Unclassified"],
    ["ole", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), "old.xlsx"],
    ["csv", Buffer.from("a,b,c\n1,2,3\n4,5,6\n"), "data.dat"],
    ["text", Buffer.from("just a plain note about things"), "note"],
    ["unknown", Buffer.from([0, 1, 2, 3, 250, 251, 0, 9, 8, 0, 0, 0, 1, 2, 3]), "mystery.bin"],
  ])("%s", (kind, bytes, name) => expect(sniffKind(bytes as Buffer, name as string).kind).toBe(kind))
  it("a zip with word/ inside is a docx, with xl/ an xlsx, otherwise a zip", async () => {
    const mk = async (path: string) => { const z = new JSZip(); z.file(path, "x"); return Buffer.from(await z.generateAsync({ type: "uint8array" })) }
    expect(sniffKind(await mk("word/document.xml")).kind).toBe("docx")
    expect(sniffKind(await mk("xl/workbook.xml")).kind).toBe("xlsx")
    expect(sniffKind(await mk("notes.txt")).kind).toBe("zip")
  })
  it("text is decoded by BOM, then UTF-8, then Windows-1252 (an Italian CSV never turns into garbage)", () => {
    expect(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x63, 0x69, 0x61, 0x6f]))).toBe("ciao")
    expect(decodeText(Buffer.from("città", "utf8"))).toBe("città")
    expect(decodeText(Buffer.from([0x63, 0x69, 0x74, 0x74, 0xe0]))).toBe("città")            // 0xE0 = à in Windows-1252
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi", "utf16le")]))).toBe("hi")
    expect(looksLikeText(Buffer.from([0, 1, 2, 3]))).toBe(false)
  })
})

describe("reading each kind", () => {
  it("a PDF with a real text layer is NOT sent to Document AI (free, fast)", async () => {
    const d = deps({ pdfTextLayer: vi.fn(async () => ({ text: "This lease agreement between the parties " + "word ".repeat(60), numpages: 2 })) })
    const r = await extractContent(Buffer.from("%PDF-1.7 x"), "lease.pdf", d)
    expect(r.problem).toBeNull(); expect(d.ocr).not.toHaveBeenCalled(); expect(r.pageCount).toBe(2)
  })
  it("a scanned PDF (empty text layer) goes to Document AI", async () => {
    const d = deps()
    const r = await extractContent(Buffer.from("%PDF-1.7 x"), "scan.pdf", d)
    expect(d.ocr).toHaveBeenCalledWith(expect.anything(), "application/pdf", "scan.pdf"); expect(r.text).toContain("SCANNED")
  })
  it("a PDF longer than was read says PARTIAL, with the real length", async () => {
    const d = deps({ ocr: vi.fn(async () => ({ fullText: "p1 p2", pages: ["p1", "p2"], documentPageCount: 90, partial: true })) })
    const r = await extractContent(Buffer.from("%PDF-1.7 x"), "big.pdf", d)
    expect(r.partial).toBe(true); expect(r.pageCount).toBe(90); expect(r.problem).toMatch(/2 of 90/)
  })
  it("a password-protected PDF is a final 'cannot be read', not an empty text", async () => {
    const d = deps({ pdfTextLayer: vi.fn(async () => { throw new Error("PasswordException: No password given") }) })
    const r = await extractContent(Buffer.from("%PDF-1.7 x"), "locked.pdf", d)
    expect(r.terminal).toBe(true); expect(r.problem).toMatch(/password/i)
  })
  it("a HEIC photo is converted to JPEG, then read; the reader sees a JPEG", async () => {
    const d = deps()
    const r = await extractContent(heic, "IMG_1.HEIC", d)
    expect(d.heicToJpeg).toHaveBeenCalledTimes(1); expect(d.ocr).toHaveBeenCalledWith(expect.anything(), "image/jpeg", "IMG_1.HEIC"); expect(r.converted).toBe(true); expect(r.visual).not.toBeNull()
  })
  it("a picture with no words says so", async () => {
    const d = deps({ ocr: vi.fn(async () => ({ fullText: " ", pages: [" "], documentPageCount: 1, partial: false })) })
    expect((await extractContent(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), "a.jpg", d)).problem).toMatch(/No words/)
  })
  it("a CSV is kept whole and decoded correctly", async () => {
    const r = await extractContent(Buffer.from("nome;città\nMario;Roma\n", "latin1"), "d.csv", deps())
    expect(r.kind).toBe("csv"); expect(r.text).toContain("città")
  })
  it("an old .xls is a final, plainly-worded 'cannot be read yet'", async () => {
    const r = await extractContent(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), "old.xls", deps())
    expect(r.terminal).toBe(true); expect(r.problem).toMatch(/old Office/)
  })
  it("an empty file, an unknown file and a too-large file are final states", async () => {
    expect((await extractContent(Buffer.alloc(0), "e.pdf", deps())).problem).toMatch(/empty/)
    expect((await extractContent(Buffer.from([0, 1, 2, 3, 250, 251, 0, 9, 8, 0, 0, 0]), "x.bin", deps())).problem).toMatch(/cannot be read/)
    expect((await extractContent(Buffer.alloc(LIMITS.maxFileBytes + 1, 0x25), "big.pdf", deps())).problem).toMatch(/too large/)
  })
})

describe("zip safety", () => {
  it("lists members, decodes small text ones, notes the rest as not read", async () => {
    const z = new JSZip(); z.file("notes.txt", "hello zip"); z.file("scan.pdf", Buffer.from("%PDF"))
    const r = await readZip(Buffer.from(await z.generateAsync({ type: "uint8array" })))
    expect(r.text).toContain("hello zip"); expect(r.text).toMatch(/scan\.pdf.*not read/)
  })
  it("too many entries is refused", async () => {
    const z = new JSZip(); for (let i = 0; i < LIMITS.zipMaxEntries + 5; i++) z.file(`f${i}.txt`, "x")
    expect(await guardZip(Buffer.from(await z.generateAsync({ type: "uint8array" })))).toMatch(/too many/)
  })
  it("a zip that inflates hugely (a zip bomb) is refused before it is opened", async () => {
    const z = new JSZip(); z.file("zeros.txt", Buffer.alloc(60 * 1024 * 1024, 0))
    const b = Buffer.from(await z.generateAsync({ type: "uint8array", compression: "DEFLATE" }))
    expect(await guardZip(b)).toMatch(/suspiciously|expand/)
  })
})
