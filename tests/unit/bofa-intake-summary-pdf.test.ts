import { describe, it, expect } from "vitest"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { buildSummaryPdf, printable, wrapText } from "@/lib/bofa-intake/summary-pdf"

describe("bofa intake summary pdf", () => {
  it("builds a readable PDF with the answers", async () => {
    const buf = await buildSummaryPdf({
      data: { full_name: "Riley Parker", company_name: "Parker Trading LLC", business_description: "We sell tea.\nWorldwide." },
      partner: "Max Scale",
      submittedAt: "2026-10-12T17:36:48Z",
      requestId: "11111111-2222-3333-4444-555555555555",
    })
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-")
    const doc = await PDFDocument.load(buf)
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1)
  })

  it("does not crash on other alphabets (they are replaced, the data stays in the database)", async () => {
    const buf = await buildSummaryPdf({ data: { full_name: "张伟 Ωmega", company_name: "Ünï Café" }, partner: null, submittedAt: null, requestId: "x" })
    expect(buf.length).toBeGreaterThan(500)
  })

  it("flows long answers onto more pages", async () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ")
    const buf = await buildSummaryPdf({ data: { business_description: long, customers: long }, partner: "P", submittedAt: null, requestId: "x" })
    expect((await PDFDocument.load(buf)).getPageCount()).toBeGreaterThan(1)
  })

  it("replaces characters the font cannot draw and wraps to the width", async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    expect(printable("Café 张", font)).toBe("Café ?")
    const lines = wrapText("aaa bbb ccc ddd eee fff", font, 10, 40)
    expect(lines.length).toBeGreaterThan(1)
    expect(wrapText("x".repeat(200), font, 10, 60).every((l) => font.widthOfTextAtSize(l, 10) <= 60)).toBe(true)
  })
})
