import { describe, it, expect } from "vitest"
import {
  classifySlackFile,
  capText,
  windowText,
  extractTextFromBuffer,
  renderCellValue,
  SLACK_FILE_TEXT_CHAR_CAP,
} from "@/lib/ai-agent/slack-file-reader"
import { looksLikeIncompleteRead } from "@/lib/ai-agent/answer-guards"

describe("classifySlackFile", () => {
  it("routes images to the vision path (handled elsewhere)", () => {
    expect(classifySlackFile("image/png", "shot.png")).toBe("image")
    expect(classifySlackFile("image/jpeg", undefined)).toBe("image")
  })

  it("classifies PDFs by mimetype OR extension", () => {
    expect(classifySlackFile("application/pdf", "doc.pdf")).toBe("pdf")
    expect(classifySlackFile("application/octet-stream", "scan.PDF")).toBe("pdf")
  })

  it("classifies Excel by spreadsheetml mimetype and .xlsx/.xls extensions", () => {
    expect(
      classifySlackFile("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "book.xlsx"),
    ).toBe("xlsx")
    expect(classifySlackFile("application/vnd.ms-excel", "old.xls")).toBe("xlsx")
    expect(classifySlackFile("application/octet-stream", "data.xlsx")).toBe("xlsx")
  })

  it("classifies Word .docx", () => {
    expect(
      classifySlackFile("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "memo.docx"),
    ).toBe("docx")
    expect(classifySlackFile("application/octet-stream", "memo.docx")).toBe("docx")
  })

  it("classifies zips (incl. WhatsApp export)", () => {
    expect(classifySlackFile("application/zip", "chat.zip")).toBe("zip")
    expect(classifySlackFile("application/x-zip-compressed", "x.zip")).toBe("zip")
  })

  it("classifies text-bearing files (text/*, json, csv, source/extension fallback)", () => {
    expect(classifySlackFile("text/plain", "notes.txt")).toBe("text")
    expect(classifySlackFile("text/csv", "rows.csv")).toBe("text")
    expect(classifySlackFile("application/json", "payload.json")).toBe("text")
    expect(classifySlackFile("application/octet-stream", "script.py")).toBe("text")
    expect(classifySlackFile("application/octet-stream", "data.tsv")).toBe("text")
  })

  it("returns unsupported for unknown binary types", () => {
    expect(classifySlackFile("application/octet-stream", "thing.bin")).toBe("unsupported")
    expect(classifySlackFile("audio/mpeg", "voice.mp3")).toBe("unsupported")
    expect(classifySlackFile(undefined, undefined)).toBe("unsupported")
  })
})

describe("capText", () => {
  it("returns text unchanged when under the cap", () => {
    expect(capText("hello", 100)).toBe("hello")
  })

  it("truncates and notes when over the cap", () => {
    const long = "x".repeat(50)
    const out = capText(long, 10)
    expect(out).toContain("xxxxxxxxxx")
    expect(out).toMatch(/truncated/)
    expect(out).toMatch(/50 chars/)
  })

  // A truncated read must be DETECTABLE as partial, not just annotated. The
  // detector scans the head only, so the marker has to be there — a tail note is
  // invisible to it, which is how a 4,000-row bank statement used to count as a
  // complete read and license "there is no wire to X in this file".
  it("marks a truncated read as incomplete, in the head, in the guard's own format", () => {
    const out = capText("x".repeat(50_000), 20_000)
    expect(looksLikeIncompleteRead(out)).toBe(true)
    expect(out.slice(0, 600)).toMatch(/"complete"\s*:\s*false/i)
  })

  it("does NOT mark an untruncated read as incomplete", () => {
    expect(looksLikeIncompleteRead(capText("a short file", 20_000))).toBe(false)
  })

  it("defaults to SLACK_FILE_TEXT_CHAR_CAP", () => {
    expect(capText("short")).toBe("short")
    expect(SLACK_FILE_TEXT_CHAR_CAP).toBeGreaterThan(1000)
  })
})

describe("windowText — long files are read in sections, to the END", () => {
  // The live failure this closes: a 125k-char amended tax return was answered
  // from its first ~4 pages because a truncated read was a dead end. Now the
  // marker names the next offset, so length is a page turn, not a wall.

  it("returns the whole text untouched when it fits", () => {
    expect(windowText("hello", 0, 100)).toBe("hello")
  })

  it("a truncated first read names the EXACT offset to continue from", () => {
    const out = windowText("x".repeat(50), 0, 10)
    expect(out).toContain("offset: 10")
    expect(looksLikeIncompleteRead(out)).toBe(true)
  })

  it("a middle window shows its range and still points onward", () => {
    const text = "a".repeat(30)
    const out = windowText(text, 10, 10)
    expect(out).toContain("10–20 of 30")
    expect(out).toContain("offset: 20")
  })

  it("the FINAL window says the file ends — no phantom continuation", () => {
    const text = "b".repeat(30)
    const out = windowText(text, 20, 10)
    expect(out).toContain("FINAL section")
    expect(out).toContain("end of file")
    expect(out).not.toContain("offset: 30")
  })

  it("an offset at or past the end yields an empty final window, not a crash", () => {
    const out = windowText("c".repeat(10), 99, 5)
    expect(out).toContain("FINAL section")
  })

  it("chaining windows by the offsets it gives you recovers the ENTIRE text", () => {
    const text = Array.from({ length: 100 }, (_, i) => `row${i}`).join("\n")
    let offset = 0
    let assembled = ""
    for (let guard = 0; guard < 50; guard++) {
      const out = windowText(text, offset, 100)
      if (out === text) {
        assembled = text
        break
      }
      // Between the 4-line head marker (3 lines + blank) and the 2-line tail
      // marker (blank + note) sits the slice.
      const lines = out.split("\n")
      assembled += lines.slice(4, -2).join("\n")
      const m = out.match(/continue with offset: (\d+)/)
      if (!m) break
      offset = Number(m[1])
      assembled += "" // windows are contiguous character ranges
    }
    // Character-exact reassembly: nothing lost, nothing duplicated.
    expect(assembled.replace(/\n/g, "")).toBe(text.replace(/\n/g, ""))
  })

  it("keeps the guard-visible incomplete marker in the head of every partial window", () => {
    const out = windowText("z".repeat(1000), 500, 100)
    expect(out.slice(0, 600)).toMatch(/"complete"\s*:\s*false/i)
  })
})

describe("extractTextFromBuffer", () => {
  it("decodes plain text as UTF-8", async () => {
    const buf = Buffer.from("ciao Antonio — è tutto qui", "utf-8")
    expect(await extractTextFromBuffer(buf, "text")).toBe("ciao Antonio — è tutto qui")
  })

  it("decodes JSON/CSV as text verbatim (no parsing)", async () => {
    const json = Buffer.from('{"a":1,"b":[2,3]}', "utf-8")
    expect(await extractTextFromBuffer(json, "text")).toBe('{"a":1,"b":[2,3]}')
  })

  it("reads text entries inside a zip and lists binary entries by name", async () => {
    const JSZip = (await import("jszip")).default
    const zip = new JSZip()
    zip.file("_chat.txt", "Antonio: ciao\nLuca: hello")
    zip.file("notes.csv", "a,b\n1,2")
    zip.file("photo.jpg", Buffer.from([0xff, 0xd8, 0xff]))
    const buf = await zip.generateAsync({ type: "nodebuffer" })
    const out = await extractTextFromBuffer(buf, "zip")
    expect(out).toContain("_chat.txt")
    expect(out).toContain("Antonio: ciao")
    expect(out).toContain("notes.csv")
    expect(out).toContain("a,b")
    // binary entry listed by name, not decoded
    expect(out).toContain("photo.jpg")
    expect(out).toMatch(/not text, not read/)
  })

  it("flattens an xlsx workbook to tab-separated rows per sheet", async () => {
    const ExcelJS = (await import("exceljs")).default
    const wb = new ExcelJS.Workbook()
    const sheet = wb.addWorksheet("Q1")
    sheet.addRow(["Month", "Revenue"])
    sheet.addRow(["Jan", 1000])
    sheet.addRow(["Feb", 2000])
    const buf = Buffer.from(await wb.xlsx.writeBuffer())
    const out = await extractTextFromBuffer(buf, "xlsx")
    expect(out).toContain("Sheet: Q1")
    expect(out).toContain("Month\tRevenue")
    expect(out).toContain("Jan\t1000")
    expect(out).toContain("Feb\t2000")
  })

  it("reads an xlsx with overlapping merged cells (Numbers → Excel export) via the strip-and-retry path", async () => {
    // Build a clean workbook, then inject OVERLAPPING mergeCell ranges into the
    // sheet XML — the artifact Apple Numbers writes, which makes a plain
    // exceljs load throw "Cannot merge already merged cells".
    const ExcelJS = (await import("exceljs")).default
    const wb = new ExcelJS.Workbook()
    const sheet = wb.addWorksheet("All Companies")
    sheet.addRow(["Company", "Status"])
    sheet.addRow(["Acme LLC", "Filed"])
    const clean = Buffer.from(await wb.xlsx.writeBuffer())

    const JSZip = (await import("jszip")).default
    const zip = await JSZip.loadAsync(clean)
    const sheetPath = "xl/worksheets/sheet1.xml"
    const xml = await zip.file(sheetPath)!.async("string")
    zip.file(
      sheetPath,
      xml.replace(
        "</sheetData>",
        '</sheetData><mergeCells count="2"><mergeCell ref="A1:B1"/><mergeCell ref="B1:C1"/></mergeCells>',
      ),
    )
    const poisoned = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }))

    // Sanity: the poisoned buffer really does kill a plain load.
    const direct = new ExcelJS.Workbook()
    await expect(direct.xlsx.load(poisoned as unknown as ArrayBuffer)).rejects.toThrow(/merge/i)

    const out = await extractTextFromBuffer(poisoned, "xlsx")
    expect(out).toContain("Sheet: All Companies")
    expect(out).toContain("Company\tStatus")
    expect(out).toContain("Acme LLC\tFiled")
  })

  it("still throws the original error for a genuinely unreadable xlsx buffer", async () => {
    await expect(extractTextFromBuffer(Buffer.from("not a zip at all"), "xlsx")).rejects.toThrow()
  })

  it("throws for image/unsupported (routed elsewhere by the caller)", async () => {
    await expect(extractTextFromBuffer(Buffer.from("x"), "image")).rejects.toThrow(/unsupported/)
    await expect(extractTextFromBuffer(Buffer.from("x"), "unsupported")).rejects.toThrow(/unsupported/)
  })
})

/**
 * The spreadsheet-reading contract (td-bug 2026-08-03, Luca's tax-returns
 * tracking sheet). Every case here is a SILENT wrong-data failure the old
 * one-line flattener shipped: a total that vanished, a date a day early, a
 * hidden tab quoted as current, a fabricated row number. None had a test.
 */
describe("renderCellValue — no cell kind may become '[object Object]'", () => {
  it("renders a formula cell as its RESULT, not the formula object", () => {
    expect(renderCellValue({ formula: "SUM(B2:B3)", result: 300 })).toBe("300")
  })

  it("keeps a legitimately zero or empty formula result (never falsiness-checked away)", () => {
    expect(renderCellValue({ formula: "SUM(B2:B3)", result: 0 })).toBe("0")
    expect(renderCellValue({ formula: 'IF(A1,"","")', result: "" })).toBe("")
  })

  it("shows the formula itself when the workbook cached no result", () => {
    expect(renderCellValue({ formula: "SUM(B2:B3)" })).toBe("=SUM(B2:B3)")
  })

  it("surfaces a formula error code rather than an object", () => {
    expect(renderCellValue({ formula: "A1/0", result: { error: "#DIV/0!" } })).toBe("#DIV/0!")
    expect(renderCellValue({ error: "#REF!" })).toBe("#REF!")
  })

  it("concatenates rich-text runs", () => {
    expect(renderCellValue({ richText: [{ text: "Acme " }, { text: "LLC" }] })).toBe("Acme LLC")
  })

  it("renders a hyperlink cell as its visible label", () => {
    expect(renderCellValue({ text: "IRS", hyperlink: "https://irs.gov" })).toBe("IRS")
  })

  it("renders a date as a plain ISO DATE in UTC — never a day early", () => {
    // Excel stores a date at UTC midnight. String(Date) on any negative-offset
    // host (all of the US) renders the PREVIOUS day — a silent off-by-one on
    // deadline sheets — and costs ~57 chars against the read window.
    expect(renderCellValue(new Date("2026-01-15T00:00:00.000Z"))).toBe("2026-01-15")
  })

  it("keeps the time only when the cell actually carries one", () => {
    expect(renderCellValue(new Date("2026-01-15T14:30:00.000Z"))).toBe("2026-01-15 14:30:00")
  })

  it("never returns '[object Object]' for an unknown tagged value", () => {
    expect(renderCellValue({ somethingNew: 1 })).not.toContain("[object Object]")
  })

  it("passes through primitives and empties", () => {
    expect(renderCellValue(1000)).toBe("1000")
    expect(renderCellValue("Filed")).toBe("Filed")
    expect(renderCellValue(null)).toBe("")
    expect(renderCellValue(undefined)).toBe("")
  })
})

describe("extractXlsx — manifest, real row numbers, hidden sheets, legacy .xls", () => {
  async function build(): Promise<Buffer> {
    const ExcelJS = (await import("exceljs")).default
    const wb = new ExcelJS.Workbook()
    const s1 = wb.addWorksheet("All Companies")
    s1.getCell("A1").value = "Company"
    s1.getCell("B1").value = "Fee"
    s1.getCell("A2").value = "Alpha LLC"
    s1.getCell("B2").value = 100
    // rows 3-4 deliberately blank
    s1.getCell("A5").value = "Total"
    s1.getCell("B5").value = { formula: "SUM(B2:B2)", result: 100 }
    const s2 = wb.addWorksheet("SMLLC")
    s2.getCell("A1").value = "smllc row"
    const s3 = wb.addWorksheet("OLD 2024")
    s3.state = "hidden"
    s3.getCell("A1").value = "superseded 999999"
    return Buffer.from(await wb.xlsx.writeBuffer())
  }

  it("emits a sheet manifest BEFORE any content, so a truncated read can't hide a tab", async () => {
    const out = await extractTextFromBuffer(await build(), "xlsx")
    const head = out.slice(0, 400)
    expect(head).toContain("WORKBOOK CONTENTS")
    // Every sheet is named in the head — this is the whole point: Luca's
    // SMLLC/MMLLC tabs were entirely past the cut-off and unmentioned.
    expect(head).toContain("All Companies")
    expect(head).toContain("SMLLC")
    expect(head).toContain("OLD 2024")
    // and the manifest precedes the first sheet body
    expect(out.indexOf("WORKBOOK CONTENTS")).toBeLessThan(out.indexOf("--- Sheet:"))
  })

  it("prefixes every line with its REAL Excel row number and marks blank gaps", async () => {
    const out = await extractTextFromBuffer(await build(), "xlsx")
    expect(out).toContain("1\tCompany\tFee")
    expect(out).toContain("2\tAlpha LLC\t100")
    // Total is on Excel row 5, not the 3rd emitted line.
    expect(out).toContain("5\tTotal\t100")
    expect(out).toContain("[rows 3-4 are empty]")
  })

  it("renders the formula total as its value, not [object Object]", async () => {
    const out = await extractTextFromBuffer(await build(), "xlsx")
    expect(out).not.toContain("[object Object]")
    expect(out).toContain("Total\t100")
  })

  it("labels a hidden sheet so superseded figures can't pass as current", async () => {
    const out = await extractTextFromBuffer(await build(), "xlsx")
    expect(out).toContain("OLD 2024 (HIDDEN in Excel)")
    expect(out).toMatch(/HIDDEN in Excel — the person looking at this workbook does NOT see it/)
  })

  it("explains a legacy .xls instead of leaking a raw library error", async () => {
    // OLE2/BIFF compound-file magic — what a real Excel 97-2003 file starts with.
    const biff = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(64),
    ])
    await expect(extractTextFromBuffer(biff, "xlsx")).rejects.toThrow(/Excel 97-2003|\.xls\b/i)
    await expect(extractTextFromBuffer(biff, "xlsx")).rejects.toThrow(/Save As|\.xlsx/i)
  })
})
