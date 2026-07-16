import { describe, it, expect } from "vitest"
import {
  buildPlainSummaryPrompt,
  parsePlainFields,
  isSubstantiveTrackerChange,
  isValidDueDate,
  clip,
  type JobSnapshot,
} from "@/lib/dev-tracker/plain-summary"

function snap(over: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    title: "Fix invoice mirror drift",
    type: "bugfix",
    priority: "high",
    channel: "td-bug",
    stageLabel: "Fixing",
    description: "payments and client_expenses drift when confirmPayment skips sync",
    findings: null,
    plan: null,
    decisions: null,
    blockers: null,
    callerSummary: null,
    progressTail: [],
    ...over,
  }
}

describe("clip", () => {
  it("returns short strings untouched", () => {
    expect(clip("hello", 10)).toBe("hello")
  })
  it("trims and truncates with ellipsis", () => {
    expect(clip("  abcdefghij  ", 4)).toBe("abcd…")
  })
  it("never splits a surrogate pair at the boundary", () => {
    const clipped = clip("ab🎉cd", 3)
    expect(clipped).toBe("ab🎉…")
    // Round-trips through JSON — a lone surrogate would not.
    expect(JSON.parse(JSON.stringify(clipped))).toBe(clipped)
  })
})

describe("isValidDueDate", () => {
  it("accepts real calendar dates", () => {
    expect(isValidDueDate("2026-07-16")).toBe(true)
    expect(isValidDueDate("2028-02-29")).toBe(true) // leap year
  })
  it("rejects regex-valid but impossible dates", () => {
    expect(isValidDueDate("2026-02-31")).toBe(false)
    expect(isValidDueDate("2026-13-01")).toBe(false)
    expect(isValidDueDate("2027-02-29")).toBe(false) // not a leap year
  })
  it("rejects wrong shapes", () => {
    expect(isValidDueDate("16-07-2026")).toBe(false)
    expect(isValidDueDate("2026-7-16")).toBe(false)
    expect(isValidDueDate("tomorrow")).toBe(false)
  })
})

describe("buildPlainSummaryPrompt", () => {
  it("includes title, type, priority, channel and stage", () => {
    const p = buildPlainSummaryPrompt(snap())
    expect(p).toContain("Fix invoice mirror drift")
    expect(p).toContain("TYPE: bugfix | PRIORITY: high | BOARD CHANNEL: td-bug")
    expect(p).toContain("CURRENT STAGE: Fixing")
  })
  it("omits empty sections entirely", () => {
    const p = buildPlainSummaryPrompt(snap({ description: null, stageLabel: null }))
    expect(p).not.toContain("REQUEST:")
    expect(p).not.toContain("CURRENT STAGE:")
    expect(p).not.toContain("FINDINGS:")
  })
  it("caps long sections", () => {
    const p = buildPlainSummaryPrompt(snap({ findings: "x".repeat(5000) }))
    const findingsBlock = p.split("FINDINGS:\n")[1]
    expect(findingsBlock.length).toBeLessThan(1600)
    expect(findingsBlock).toContain("…")
  })
  it("keeps only the last 5 progress entries", () => {
    const tail = Array.from({ length: 9 }, (_, i) => ({ date: `d${i}`, action: `a${i}`, result: `r${i}` }))
    const p = buildPlainSummaryPrompt(snap({ progressTail: tail }))
    expect(p).not.toContain("a3 →")
    expect(p).toContain("a4 →")
    expect(p).toContain("a8 →")
  })
  it("includes the caller summary as a labelled hint", () => {
    const p = buildPlainSummaryPrompt(snap({ callerSummary: "Card sync bug being fixed" }))
    expect(p).toContain("DRAFT SUMMARY FROM THE SESSION")
    expect(p).toContain("Card sync bug being fixed")
  })
})

describe("parsePlainFields", () => {
  const good = {
    summary_plain: "We are fixing a billing display bug.",
    business_impact: "Some paid invoices looked unpaid to clients.",
    simple_next_step: "Claude finishes the fix and tests it.",
  }
  it("parses a clean JSON reply", () => {
    expect(parsePlainFields(JSON.stringify(good))).toEqual(good)
  })
  it("parses JSON wrapped in code fences and prose", () => {
    const wrapped = "Sure! Here you go:\n```json\n" + JSON.stringify(good) + "\n```\nDone."
    expect(parsePlainFields(wrapped)).toEqual(good)
  })
  it("returns null when a field is missing", () => {
    expect(parsePlainFields(JSON.stringify({ summary_plain: "a", business_impact: "b" }))).toBeNull()
  })
  it("returns null when a field is empty or non-string", () => {
    expect(parsePlainFields(JSON.stringify({ ...good, simple_next_step: "  " }))).toBeNull()
    expect(parsePlainFields(JSON.stringify({ ...good, business_impact: 42 }))).toBeNull()
  })
  it("returns null on garbage", () => {
    expect(parsePlainFields("I could not produce JSON, sorry")).toBeNull()
    expect(parsePlainFields("{ broken json")).toBeNull()
  })
  it("caps runaway field lengths", () => {
    const long = parsePlainFields(JSON.stringify({ ...good, summary_plain: "y".repeat(2000) }))
    expect(long).not.toBeNull()
    expect(long!.summary_plain.length).toBeLessThanOrEqual(401)
  })
})

describe("isSubstantiveTrackerChange", () => {
  it("is true for milestone / progress / narrative field changes", () => {
    expect(isSubstantiveTrackerChange({ milestone: "building" })).toBe(true)
    expect(isSubstantiveTrackerChange({ progress_entry: { action: "a", result: "r" } })).toBe(true)
    expect(isSubstantiveTrackerChange({ findings: "found it" })).toBe(true)
    expect(isSubstantiveTrackerChange({ blockers: "" })).toBe(true) // clearing blockers changes the story
    expect(isSubstantiveTrackerChange({ finalStatus: "done" })).toBe(true)
  })
  it("is false for pure metadata edits", () => {
    expect(isSubstantiveTrackerChange({})).toBe(false)
    expect(isSubstantiveTrackerChange({ finalStatus: "in_progress" })).toBe(false)
  })
})
