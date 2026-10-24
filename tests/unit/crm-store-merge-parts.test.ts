import { describe, it, expect } from "vitest"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { mergeParts, partKind, looksMergeable, suggestMergedName, jpegRotation, MergeError, MERGE_MAX_PARTS, MERGE_MAX_TOTAL_BYTES } from "@/lib/crm-store/merge-parts"

// a real 1x1 PNG and a real 1x1 JPEG
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"))
const JPG = Uint8Array.from(Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64"))

async function pdf(pages: number): Promise<Uint8Array> {
  const d = await PDFDocument.create()
  for (let i = 0; i < pages; i++) d.addPage([300 + i, 400])
  return await d.save()
}
const part = (name: string, bytes: Uint8Array, mimeType: string | null = null) => ({ name, mimeType, bytes })

describe("partKind (by the first bytes, not the name)", () => {
  it("knows PDF, PNG, JPG and refuses the rest", async () => {
    expect(partKind(await pdf(1))).toBe("pdf")
    expect(partKind(PNG)).toBe("png")
    expect(partKind(JPG)).toBe("jpg")
    expect(partKind(new Uint8Array([80, 75, 3, 4, 0, 0, 0, 0, 0, 0]))).toBe("unsupported") // a .docx / .xlsx zip
  })
})

describe("mergeParts", () => {
  it("appends PDFs in the order given and counts the pages", async () => {
    const r = await mergeParts([part("return.pdf", await pdf(3)), part("fax.pdf", await pdf(2))])
    expect(r.pageCounts).toEqual([3, 2])
    const out = await PDFDocument.load(r.bytes)
    expect(out.getPageCount()).toBe(5)
    // the order is kept: the first PDF's pages are 300,301,302 wide, the second's 300,301
    expect(out.getPages().map((p) => Math.round(p.getWidth()))).toEqual([300, 301, 302, 300, 301])
  })
  it("a fax receipt that is a PNG or JPG becomes one page", async () => {
    const r = await mergeParts([part("return.pdf", await pdf(1)), part("fax.png", PNG), part("scan.jpg", JPG)])
    expect(r.pageCounts).toEqual([1, 1, 1])
    expect((await PDFDocument.load(r.bytes)).getPageCount()).toBe(3)
  })
  it("the same inputs give the same bytes (so the identical-file check keeps working)", async () => {
    const a = [part("a.pdf", await pdf(2)), part("b.png", PNG)]
    const x = await mergeParts(a)
    const y = await mergeParts(a)
    expect(Buffer.from(x.bytes).equals(Buffer.from(y.bytes))).toBe(true)
  })
  it("refuses fewer than two files and more than the limit", async () => {
    await expect(mergeParts([part("a.pdf", await pdf(1))])).rejects.toThrow(MergeError)
    const many = await Promise.all(Array.from({ length: MERGE_MAX_PARTS + 1 }, async (_, i) => part(`f${i}.pdf`, await pdf(1))))
    await expect(mergeParts(many)).rejects.toThrow(/At most/)
  })
  it("names the file it cannot merge (Word/Excel)", async () => {
    await expect(mergeParts([part("a.pdf", await pdf(1)), part("book.xlsx", new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4, 5, 6]))])).rejects.toThrow(/"book\.xlsx" is not a PDF, PNG or JPG/)
  })
  it("refuses a protected (encrypted) PDF by name, with the right explanation", async () => {
    const locked = Uint8Array.from(Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n5 0 obj<</Filter/Standard/V 1/R 2>>endobj\ntrailer<</Root 1 0 R/Encrypt 5 0 R>>\n%%EOF"))
    await expect(mergeParts([part("a.pdf", await pdf(1)), part("locked.pdf", locked)])).rejects.toThrow(/"locked\.pdf" is protected/)
  })
  it("a harmless PDF that merely CONTAINS the text /Encrypt is not called locked", async () => {
    const d = await PDFDocument.create()
    const page = d.addPage([300, 400])
    page.drawText("see /Encrypt in the spec", { x: 20, y: 300, size: 10, font: await d.embedFont(StandardFonts.Helvetica) })
    const r = await mergeParts([part("a.pdf", await pdf(1)), part("spec.pdf", await d.save({ useObjectStreams: false }))])
    expect(r.pageCounts).toEqual([1, 1])
  })
  it("a damaged PDF is named, never silently skipped", async () => {
    const bad = Uint8Array.from(Buffer.from("%PDF-1.4 this is not a real pdf"))
    await expect(mergeParts([part("a.pdf", await pdf(1)), part("bad.pdf", bad)])).rejects.toThrow(/"bad\.pdf" cannot be opened/)
  })
})

describe("hardening after the Bug Hunter's review", () => {
  it("a picture whose metadata mentions %PDF- is still a picture, not a PDF", () => {
    const sneaky = new Uint8Array([...JPG.subarray(0, 2), 0xff, 0xe1, 0, 20, ...Buffer.from("%PDF-1.4 metadata  "), ...JPG.subarray(2)])
    expect(partKind(sneaky)).toBe("jpg")
  })
  it("an empty file is named", async () => {
    await expect(mergeParts([part("a.pdf", await pdf(1)), part("empty.pdf", new Uint8Array(0))])).rejects.toThrow(/"empty\.pdf" is empty/)
  })
  it("the total size limit is 80 MB and is named", async () => {
    const big = (n: string) => part(n, new Uint8Array(41 * 1048576))
    await expect(mergeParts([big("x.pdf"), big("y.pdf")])).rejects.toThrow(/limit for a merge is 80 MB/)
    expect(MERGE_MAX_TOTAL_BYTES).toBe(80 * 1048576)
  })
  it("a phone photo's EXIF rotation is kept (the page is turned, not the file left sideways)", async () => {
    // a JPEG with an EXIF block saying "rotate 90° clockwise" (orientation 6)
    const exif = Uint8Array.from([0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // APP1 "Exif\0\0"
      0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,                                       // TIFF header, big endian, IFD at 8
      0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00,   // one entry: orientation, SHORT, 1, value 6
      0x00, 0x00, 0x00, 0x00])                                                               // end of the IFD list
    const rotated = new Uint8Array([...JPG.subarray(0, 2), ...exif, ...JPG.subarray(2)])
    expect(jpegRotation(rotated)).toBe(90)
    expect(jpegRotation(JPG)).toBe(0)
    const r = await mergeParts([part("a.pdf", await pdf(1)), part("photo.jpg", rotated)])
    const out = await PDFDocument.load(r.bytes)
    expect(out.getPage(1).getRotation().angle).toBe(90)
    expect(out.getPage(0).getRotation().angle).toBe(0)
  })
  it("a filled-in form keeps its typed values (the fields are printed into the page)", async () => {
    const d = await PDFDocument.create()
    const page = d.addPage([300, 400])
    const field = d.getForm().createTextField("name")
    field.setText("Antonio")
    field.addToPage(page, { x: 20, y: 300, width: 150, height: 20 })
    const r = await mergeParts([part("a.pdf", await pdf(1)), part("form.pdf", await d.save())])
    const out = await PDFDocument.load(r.bytes)
    expect(out.getPageCount()).toBe(2)
    expect(out.getForm().getFields().length).toBe(0) // flattened: no live fields left, the text is part of the page
  })
})

describe("names", () => {
  it("looksMergeable judges the name for the dialog", () => {
    expect(looksMergeable("x.PDF", null)).toBe(true)
    expect(looksMergeable("fax.png", null)).toBe(true)
    expect(looksMergeable("scan", "image/jpeg")).toBe(true)
    expect(looksMergeable("book.xlsx", "application/vnd.ms-excel")).toBe(false)
    expect(looksMergeable("letter.docx", null)).toBe(false)
  })
  it("suggestMergedName joins the first two and counts the rest", () => {
    expect(suggestMergedName(["Form 1120 - Acme.pdf", "Fax receipt.png"])).toBe("Form 1120 - Acme + Fax receipt.pdf")
    expect(suggestMergedName(["A.pdf", "B.pdf", "C.pdf", "D.pdf"])).toBe("A + B + 2 more.pdf")
    expect(suggestMergedName([])).toBe("Merged document.pdf")
    expect(suggestMergedName(["x".repeat(300) + ".pdf", "y.pdf"]).length).toBeLessThanOrEqual(124)
  })
})
