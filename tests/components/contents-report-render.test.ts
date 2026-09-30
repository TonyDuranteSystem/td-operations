import { describe, it, expect } from "vitest"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ContentsReport, type UnderstandReportData, type UnderstandRow } from "@/components/storage/contents-report"

const row = (over: Partial<UnderstandRow>): UnderstandRow => ({
  fileId: "f1", analysisId: "a1", name: "Resolution - X.pdf", folder: "1. Company", currentTypeSlug: null, currentType: null, kind: "pdf", status: "judged",
  verdict: "red", reasons: ["crm_none", "no_example"], reasonTexts: ["There is no CRM record to check it against.", "No confirmed example of this kind yet."],
  aiTypeSlug: "articles_of_organization", aiType: "Articles of Organization", aiName: "Articles of Organization - Dieci Dieci Company LLC", aiReason: "It is a Delaware certificate of formation.",
  identity: false, words: 120, problem: null, twin: null, ...over,
})
const data = (rows: UnderstandRow[], aiOn = true): UnderstandReportData => ({ runId: "r", rows, unfinished: 0, aiOn, spentTodayUsd: 0.04, capUsd: 5 })
const html = (d: UnderstandReportData) => renderToStaticMarkup(React.createElement(ContentsReport, { title: "DIECI DIECI", data: d, onClose: () => {}, onChanged: () => {} }))

describe("the Check contents screen", () => {
  it("shows what the AI understood, the plain-words reasons, and the ordinary buttons — for a misnamed certificate", () => {
    const h = html(data([row({})]))
    expect(h).toContain("Articles of Organization"); expect(h).toContain("no type"); expect(h).toContain("There is no CRM record")
    expect(h).toContain("Use this type…"); expect(h).toContain("Use this name"); expect(h).toContain("Dismiss")
    expect(h).toContain("0 green, 1 red")
  })
  it("a green file offers no change — only a confirm when its type already matches", () => {
    const h = html(data([row({ verdict: "green", reasons: [], reasonTexts: [], currentTypeSlug: "articles_of_organization", currentType: "Articles of Organization", aiName: null })]))
    expect(h).toContain("1 green, 0 red"); expect(h).not.toContain("Use this type…"); expect(h).toContain("Confirm — this is right")
  })
  it("look-alike files: identical copies offer 'Remove this copy'; files that differ by a number never do", () => {
    const same = row({ fileId: "p1", name: "Unclassified.HEIC", twin: { fileId: "p2", name: "Paasaporto.HEIC", folder: "Personal documents", kind: "same_bytes", note: "Identical files (every byte).", differences: [] } })
    expect(html(data([same]))).toContain("Remove this copy")
    const diff = row({ twin: { fileId: "t", name: "Invoice copy.pdf", folder: "1. Company", kind: "different_words", note: "A number or date differs (800) — these are different documents.", differences: [] } })
    const h = html(data([diff]))
    expect(h).toContain("different documents"); expect(h).not.toContain("Remove this copy")
  })
  it("minor marks are shown to a person with the marks quoted, and no removal is offered", () => {
    const h = html(data([row({ name: "Office Lease.pdf", twin: { fileId: "t", name: "Office Lease (2).pdf", folder: "1. Company", kind: "minor_marks", note: "Same words except 2 stray mark(s).", differences: [{ onlyInA: ["ΑΣ", "Α2"], onlyInB: [] }] } })]))
    expect(h).toContain("ΑΣ Α2"); expect(h).not.toContain("Remove this copy")
  })
  it("says so when the AI is off, and shows the spend", () => {
    const h = html(data([row({ aiTypeSlug: null, aiType: null, aiName: null })], false))
    expect(h).toContain("The AI is switched off here"); expect(h).toContain("$0.04 of $5.00")
  })
  it("an unreadable file shows its plain-words problem", () => {
    expect(html(data([row({ status: "unreadable", aiTypeSlug: null, aiType: null, aiName: null, problem: "This is an old Office file (.xls/.doc/.ppt) — it cannot be read yet." })]))).toContain("old Office file")
  })
})
