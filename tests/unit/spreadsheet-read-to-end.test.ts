import { describe, it, expect } from "vitest"
import { extractTextFromBuffer, windowText } from "@/lib/ai-agent/slack-file-reader"
import { extractArtifact } from "@/lib/ai-agent/worker-tools"

/**
 * END-TO-END for Luca's actual case (td-bug, thread "AI Agent", 2026-07-21 → 08-03).
 *
 * His request was: "check this file and see if the sections SMLLC and MMLLC are
 * up to date with the information given in the ALL Companies section". The file
 * was a three-tab tracking workbook. What he got instead, in the assistant's own
 * words: "the reader caps out at 20,000 characters and this file is 61,725 — I
 * received the All Companies list only up to row ~144 (of 225), and the SMLLC /
 * MMLLC sheets are entirely in the cut-off part. I verified there's no way for me
 * to pull the rest of a chat-attached file."
 *
 * This rebuilds a workbook of that shape and walks it the way the assistant now
 * can, proving the two things that were false before: the tabs are ANNOUNCED even
 * when their rows are past the cut, and paging reaches the end.
 */
async function buildTrackingWorkbook(): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default
  const wb = new ExcelJS.Workbook()

  const all = wb.addWorksheet("All Companies")
  all.addRow(["Company", "Status", "Fee", "Filed on"])
  for (let i = 1; i <= 225; i++) {
    all.addRow([
      `Company Number ${i} LLC — a deliberately long name to burn characters`,
      i % 3 === 0 ? "Filed" : "Pending",
      100 + i,
      new Date(Date.UTC(2026, 0, 15)),
    ])
  }
  // The total is a FORMULA — the cell that used to arrive as "[object Object]".
  all.addRow(["TOTAL", "", { formula: "SUM(C2:C226)", result: 25987 }, ""])

  const smllc = wb.addWorksheet("SMLLC")
  smllc.addRow(["Company", "Member"])
  smllc.addRow(["Company Number 7 LLC", "Mario Rossi"])

  const mmllc = wb.addWorksheet("MMLLC")
  mmllc.addRow(["Company", "Members"])
  mmllc.addRow(["Company Number 9 LLC", "Two members"])

  return Buffer.from(await wb.xlsx.writeBuffer())
}

describe("Luca's tracking workbook — the whole file is reachable now", () => {
  it("is genuinely longer than one read window (the premise of the bug)", async () => {
    const text = await extractTextFromBuffer(await buildTrackingWorkbook(), "xlsx")
    expect(text.length).toBeGreaterThan(20_000)
  })

  it("NAMES all three tabs in the first window, even though two are past the cut", async () => {
    const text = await extractTextFromBuffer(await buildTrackingWorkbook(), "xlsx")
    const firstWindow = windowText(text, 0, 20_000)

    // This is the exact sentence from Luca's screenshot: the SMLLC/MMLLC sheets
    // were "entirely in the cut-off part" and nothing said they existed.
    expect(firstWindow).toContain("All Companies")
    expect(firstWindow).toContain("SMLLC")
    expect(firstWindow).toContain("MMLLC")
    // …and the marker still declares the read incomplete.
    expect(firstWindow.slice(0, 600)).toMatch(/"complete"\s*:\s*false/i)
  })

  it("reaches the END by following the offsets, and finds the last tab's rows", async () => {
    const text = await extractTextFromBuffer(await buildTrackingWorkbook(), "xlsx")

    // Walk it exactly as the assistant now does: read, follow "continue with
    // offset: N", repeat. Bounded well under the forced-continuation ceiling.
    let offset = 0
    let seen = ""
    let passes = 0
    for (; passes < 20; passes++) {
      const chunk = windowText(text, offset, 20_000)
      seen += chunk
      const more = chunk.match(/continue with offset: (\d+)\]$/m)
      if (!more) break
      offset = Number(more[1])
    }

    expect(passes).toBeLessThan(20)
    expect(seen).toMatch(/\[end of file/)
    // The rows that were unreachable before — Luca's actual question.
    expect(seen).toContain("Mario Rossi")
    expect(seen).toContain("Two members")
  })

  it("delivers the formula TOTAL as a number, not as an object", async () => {
    const text = await extractTextFromBuffer(await buildTrackingWorkbook(), "xlsx")
    expect(text).not.toContain("[object Object]")
    expect(text).toContain("TOTAL\t\t25987")
  })

  it("delivers dates as the day they actually are", async () => {
    const text = await extractTextFromBuffer(await buildTrackingWorkbook(), "xlsx")
    expect(text).toContain("2026-01-15")
    // The old rendering was both enormous and a day early on any US host.
    expect(text).not.toMatch(/Jan 14 2026/)
  })
})

describe("giving a spreadsheet back — the panel gets a spreadsheet button, not a PDF one", () => {
  it("labels an .xlsx download correctly", () => {
    const result = [
      "📈 Spreadsheet ready — 2 sheet(s), 12 rows, 8 KB",
      "Download: https://example.supabase.co/storage/v1/object/sign/x/worker-chat/abc.xlsx?token=t",
      "",
      "The link works for 24 hours.",
    ].join("\n")
    const art = extractArtifact("spreadsheet_create", result)
    expect(art).not.toBeNull()
    expect(art!.kind).toBe("spreadsheet")
    expect(art!.label).toMatch(/spreadsheet/i)
  })

  it("still labels a PDF a PDF", () => {
    const result = ["📄 PDF ready — 4 KB", "Download: https://example.supabase.co/x/worker-chat/abc.pdf?token=t"].join("\n")
    const art = extractArtifact("pdf_create", result)
    expect(art!.kind).toBe("pdf")
    expect(art!.label).toMatch(/PDF/)
  })

  it("recognises a spreadsheet produced THROUGH the bridge wrapper", () => {
    // The worker usually reaches catalog tools via use_tool, so keying the label
    // off the tool NAME would have mislabelled every bridged spreadsheet.
    const result = [
      "📈 Spreadsheet ready — 1 sheet(s), 3 rows, 5 KB",
      "Download: https://example.supabase.co/x/worker-chat/def.xlsx?token=t",
    ].join("\n")
    expect(extractArtifact("use_tool", result)!.kind).toBe("spreadsheet")
  })

  it("ignores a link that came from somewhere else entirely", () => {
    expect(extractArtifact("gmail_read", "Download: https://evil.example.com/x.xlsx")).toBeNull()
  })
})
