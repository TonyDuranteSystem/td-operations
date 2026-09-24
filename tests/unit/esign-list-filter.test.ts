import { describe, it, expect } from "vitest"
import { matchesTab, matchesSearch, filterEsignRows, countByTab } from "@/lib/esign/list-filter"

const rows = [
  { id: "1", document_name: "Form 1120 - PrimeEdge Consulting LLC", status: "expired", company_name: "PrimeEdge Consulting LLC" },
  { id: "2", document_name: "2025 Return", status: "sent", company_name: "Maria Augusta LLC" },
  { id: "3", document_name: "8879 Terra", status: "completed", company_name: null },
  { id: "4", document_name: "Old draft", status: "voided", company_name: "X LLC" },
  { id: "5", document_name: null, status: "in_progress", company_name: undefined },
  { id: "6", document_name: "Declined one", status: "declined" },
  { id: "7", document_name: "Draft doc", status: "draft" },
]

describe("matchesTab", () => {
  it("needs action = draft, sent, in_progress, expired", () => {
    expect(["draft", "sent", "in_progress", "expired"].every(s => matchesTab(s, "action"))).toBe(true)
    expect(["completed", "declined", "voided", null, undefined, ""].some(s => matchesTab(s, "action"))).toBe(false)
  })
  it("completed only matches completed", () => {
    expect(matchesTab("completed", "completed")).toBe(true)
    expect(matchesTab("expired", "completed")).toBe(false)
  })
  it("all matches everything, including unknown/null", () => {
    expect(matchesTab(null, "all")).toBe(true)
    expect(matchesTab("weird", "all")).toBe(true)
  })
})

describe("matchesSearch", () => {
  it("empty or whitespace query matches", () => {
    expect(matchesSearch(rows[0], "")).toBe(true)
    expect(matchesSearch(rows[0], "   ")).toBe(true)
  })
  it("matches document name case-insensitively", () => {
    expect(matchesSearch(rows[2], "TERRA")).toBe(true)
  })
  it("matches company name when the document name does not", () => {
    expect(matchesSearch(rows[1], "augusta")).toBe(true)
  })
  it("tolerates null names", () => {
    expect(matchesSearch(rows[4], "x")).toBe(false)
  })
  it("trims the query", () => {
    expect(matchesSearch(rows[0], "  primeedge ")).toBe(true)
  })
})

describe("filterEsignRows / countByTab", () => {
  it("default view surfaces the expired PrimeEdge document", () => {
    expect(filterEsignRows(rows, "action", "primeedge").map(r => r.id)).toEqual(["1"])
  })
  it("search across all tab", () => {
    expect(filterEsignRows(rows, "all", "llc").map(r => r.id)).toEqual(["1", "2", "4"])
  })
  it("counts per tab", () => {
    expect(countByTab(rows)).toEqual({ action: 4, completed: 1, all: 7 })
  })
  it("empty input", () => {
    expect(filterEsignRows([], "action", "")).toEqual([])
    expect(countByTab([])).toEqual({ action: 0, completed: 0, all: 0 })
  })
})
