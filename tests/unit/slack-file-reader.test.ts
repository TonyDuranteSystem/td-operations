import { describe, it, expect } from "vitest"
import {
  classifySlackFile,
  capText,
  windowText,
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

  it("throws for image/unsupported (routed elsewhere by the caller)", async () => {
    await expect(extractTextFromBuffer(Buffer.from("x"), "image")).rejects.toThrow(/unsupported/)
    await expect(extractTextFromBuffer(Buffer.from("x"), "unsupported")).rejects.toThrow(/unsupported/)
  })
})
