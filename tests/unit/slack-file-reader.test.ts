import { describe, it, expect } from "vitest"
import {
  classifySlackFile,
  capText,
  extractTextFromBuffer,
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

  it("throws for image/unsupported (routed elsewhere by the caller)", async () => {
    await expect(extractTextFromBuffer(Buffer.from("x"), "image")).rejects.toThrow(/unsupported/)
    await expect(extractTextFromBuffer(Buffer.from("x"), "unsupported")).rejects.toThrow(/unsupported/)
  })
})
