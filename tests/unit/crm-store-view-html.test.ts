import { describe, it, expect } from "vitest"
import { viewKindFor, escapeHtml, renderTextView, renderSheetsView, sanitizeDocxHtml, cellText, wrapPage } from "@/lib/crm-store/view-html"

describe("viewKindFor", () => {
  it("knows Word, Excel and text-like files by name or type", () => {
    expect(viewKindFor("Plan.docx", null)).toBe("docx")
    expect(viewKindFor("x", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx")
    expect(viewKindFor("Budget.XLSX", "application/octet-stream")).toBe("xlsx")
    expect(viewKindFor("notes.md", "application/octet-stream")).toBe("text")
    expect(viewKindFor("data.csv", "text/csv")).toBe("text")
  })
  it("leaves PDFs, pictures, PowerPoint and old Office files to the other paths", () => {
    expect(viewKindFor("a.pdf", "application/pdf")).toBeNull()
    expect(viewKindFor("a.png", "image/png")).toBeNull()
    expect(viewKindFor("deck.pptx", null)).toBeNull()
    expect(viewKindFor("old.doc", "application/msword")).toBeNull()
    expect(viewKindFor("old.xls", "application/vnd.ms-excel")).toBeNull()
  })
})

describe("nothing in a document can run", () => {
  it("escapes text", () => {
    expect(escapeHtml(`<script>alert("x")</script>&'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;")
    expect(renderTextView("a.md", "<img src=x onerror=alert(1)>")).not.toContain("<img")
  })
  it("escapes the title and cells", () => {
    expect(wrapPage("<b>t</b>", "")).not.toContain("<b>t</b>")
    expect(renderSheetsView("b.xlsx", [{ name: "<i>S</i>", rows: [["<h>", "ok"], ["<script>1</script>", "2"]], totalRows: 2, totalCols: 2 }])).not.toMatch(/<script>|<i>S<\/i>|<h>/)
  })
  it("says when a sheet was cut", () => {
    expect(renderSheetsView("b.xlsx", [{ name: "S", rows: [["a"]], totalRows: 900, totalCols: 1 }])).toContain("first 1 of 900 rows")
  })
  it("sanitizes converted Word html: no script/style/iframe, no handlers, only safe links and inline pictures", () => {
    const dirty = `<p onclick="x()">Hi <a href="javascript:alert(1)">bad</a> <a href="https://a.test/x?y=1&z=2">good</a> <a href="#top">in</a></p><script>alert(1)</script><style>p{}</style><iframe src="https://e.test"></iframe><img src="https://tracker.test/p.gif"><img src="data:image/png;base64,AAAA"><object data="x"></object>`
    const clean = sanitizeDocxHtml(dirty)
    expect(clean).not.toMatch(/<script|<style|<iframe|<object|onclick|javascript:|tracker\.test/i)
    expect(clean).toContain('href="https://a.test/x?y=1&amp;z=2"')
    expect(clean).toContain('href="#top"')
    expect(clean).toContain('src="data:image/png;base64,AAAA"')
  })
})

describe("cellText", () => {
  it("reads every kind of Excel value", () => {
    expect(cellText(null)).toBe("")
    expect(cellText(12.5)).toBe("12.5")
    expect(cellText({ richText: [{ text: "a" }, { text: "b" }] })).toBe("ab")
    expect(cellText({ formula: "A1+1", result: 3 })).toBe("3")
    expect(cellText({ text: "link", hyperlink: "https://x.test" })).toBe("link")
    expect(cellText(new Date("2026-10-02T00:00:00Z"))).toBe("2026-10-02")
  })
})

describe("xlsxToViewHtml — a real workbook", () => {
  it("shows every sheet as a table, escapes cells, reads formulas and cuts very long sheets", async () => {
    const ExcelJS = (await import("exceljs")).default
    const { xlsxToViewHtml, VIEW_MAX_ROWS } = await import("@/lib/crm-store/view-html")
    const wb = new ExcelJS.Workbook()
    const a = wb.addWorksheet("Budget <2026>")
    a.addRow(["Item", "Cost"]); a.addRow(["<script>alert(1)</script>", 10]); a.addRow(["Total", { formula: "SUM(B2:B2)", result: 10 }])
    const b = wb.addWorksheet("Long")
    for (let i = 0; i < VIEW_MAX_ROWS + 50; i++) b.addRow([`row ${i}`])
    const buf = Buffer.from(await wb.xlsx.writeBuffer())
    const html = await xlsxToViewHtml("book.xlsx", buf)
    expect(html).toContain("<h3>Budget &lt;2026&gt;</h3>")
    expect(html).toContain("<th>Item</th>")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).not.toContain("<script>")
    expect(html).toContain("<td>10</td>")
    expect(html).toContain(`first ${VIEW_MAX_ROWS} of ${VIEW_MAX_ROWS + 50} rows`)
  })
})
