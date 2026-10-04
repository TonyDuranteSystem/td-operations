import { describe, it, expect } from "vitest"
import { PDFDocument } from "pdf-lib"
import { createHash } from "crypto"
import { mergePdfs, looksLikePdf, PdfMergeError } from "@/lib/crm-store/pdf-merge"

async function pdf(pages: number, title = "x"): Promise<Buffer> {
  const d = await PDFDocument.create()
  for (let i = 0; i < pages; i++) d.addPage([300, 400]).drawText(`${title} page ${i + 1}`)
  return Buffer.from(await d.save())
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex")

describe("mergePdfs", () => {
  it("puts the certificate pages after the document, one file", async () => {
    const m = await mergePdfs([await pdf(3, "doc"), await pdf(2, "cert")])
    expect(m.pageCounts).toEqual([3, 2])
    const re = await PDFDocument.load(m.bytes)
    expect(re.getPageCount()).toBe(5)
  })

  it("is deterministic: the same inputs give the same bytes (a retry never adds a version)", async () => {
    const a = await pdf(2, "a"), b = await pdf(1, "b")
    const m1 = await mergePdfs([a, b])
    await new Promise((r) => setTimeout(r, 1100)) // a clock difference must not change the file
    const m2 = await mergePdfs([a, b])
    expect(sha(m1.bytes)).toBe(sha(m2.bytes))
  })

  it("merges more than one certificate in the order given", async () => {
    const m = await mergePdfs([await pdf(1), await pdf(1), await pdf(1)])
    expect(m.pageCounts).toEqual([1, 1, 1])
  })

  it("refuses a part that is not a PDF", async () => {
    await expect(mergePdfs([await pdf(1), Buffer.from("hello")])).rejects.toBeInstanceOf(PdfMergeError)
  })

  it("refuses a damaged PDF instead of producing a short document", async () => {
    const good = await pdf(2)
    const broken = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("garbage not a pdf at all")])
    await expect(mergePdfs([good, broken])).rejects.toBeInstanceOf(PdfMergeError)
  })

  it("refuses an encrypted PDF (its pages would copy over blank)", async () => {
    // a minimal marker is enough for pdf-lib to refuse: load() throws EncryptedPDFError on /Encrypt
    const d = await PDFDocument.create(); d.addPage()
    const raw = Buffer.from(await d.save({ useObjectStreams: false }))
    const enc = Buffer.from(raw.toString("latin1").replace("trailer\n<<", "trailer\n<<\n/Encrypt 99 0 R"), "latin1")
    expect(enc.toString("latin1")).toContain("/Encrypt")
    await expect(mergePdfs([await pdf(1), enc])).rejects.toBeInstanceOf(PdfMergeError)
  })

  it("needs at least a document and one certificate", async () => {
    await expect(mergePdfs([await pdf(1)])).rejects.toBeInstanceOf(PdfMergeError)
  })

  it("looksLikePdf checks the header", () => {
    expect(looksLikePdf(Buffer.from("%PDF-1.4 ..."))).toBe(true)
    expect(looksLikePdf(Buffer.from("<html>"))).toBe(false)
  })
})
