import { describe, it, expect } from "vitest"
import { closingBriefLines, closingHeadline, closingWarning, type ClosingBrief } from "@/lib/closure/closing-brief"
import { checkNoteFrom } from "@/lib/operations/close-company"

// Company Closure Part C (dev job a6bbea09): the ask-first question now names the company and what goes with it.
const base: ClosingBrief = {
  companyName: "QA PartC Epsilon LLC",
  alreadyClosed: false,
  openServices: [],
  pendingDeadlines: 0,
  unpaid: { count: 0, totals: {} },
  openTasks: 0,
  members: 0,
  hasLease: false,
  checkNote: null,
}

describe("closing question brief", () => {
  it("names the company being closed", () => {
    expect(closingHeadline(base)).toBe("Finishing this job closes QA PartC Epsilon LLC.")
  })

  it("says so plainly when the company is already Closed: only what is still open is tidied, nobody loses access again", () => {
    const b = { ...base, alreadyClosed: true, openServices: [{ type: "Tax Return", status: "active" }], unpaid: { count: 2, totals: { USD: 10 } }, members: 2, hasLease: true }
    expect(closingHeadline(b)).toContain("already Closed")
    const lines = closingBriefLines(b).join(" ")
    expect(lines).toContain("Tax Return")
    expect(lines).toContain("2 unpaid invoices")
    expect(lines).not.toContain("lose portal access")
    expect(lines).not.toContain("lease")
  })

  it("a company with nothing attached lists nothing under the headline", () => {
    expect(closingBriefLines(base)).toEqual([])
  })

  it("lists the other services, marking a held or blocked one", () => {
    const lines = closingBriefLines({ ...base, openServices: [{ type: "Tax Return", status: "on_hold" }, { type: "State RA Renewal", status: "active" }, { type: "Banking", status: "blocked" }] })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("3 other services will be cancelled")
    expect(lines[0]).toContain("Tax Return (on hold)")
    expect(lines[0]).toContain("State RA Renewal,")
    expect(lines[0]).toContain("Banking (blocked)")
  })

  it("shows unpaid invoices with the sum per currency and tells staff to collect first", () => {
    const lines = closingBriefLines({ ...base, unpaid: { count: 2, totals: { USD: 120, EUR: 80.5 } } })
    expect(lines[0]).toContain("2 unpaid invoices ($120 + €80.50) will be cancelled")
    expect(lines[0]).toContain("collect first")
    expect(closingBriefLines({ ...base, unpaid: { count: 1, totals: { USD: 120 } } })[0]).toContain("1 unpaid invoice ($120)")
  })

  it("counts deadlines, to-dos and people, singular and plural", () => {
    expect(closingBriefLines({ ...base, pendingDeadlines: 1, openTasks: 1, members: 1 })).toEqual([
      "1 upcoming deadline will be cancelled.",
      "1 open to-do of the company will be cancelled.",
      "1 person linked to the company will lose portal access to it.",
    ])
    expect(closingBriefLines({ ...base, pendingDeadlines: 3, openTasks: 4, members: 2 })).toEqual([
      "3 upcoming deadlines will be cancelled.",
      "4 open to-dos of the company will be cancelled.",
      "2 people linked to the company will lose portal access to it.",
    ])
  })

  it("mentions the lease only when there is one", () => {
    expect(closingBriefLines({ ...base, hasLease: true }).join(" ")).toContain("mailing-address lease")
    expect(closingBriefLines(base).join(" ")).not.toContain("lease")
  })

  it("an unknown currency is shown with its code, not dropped", () => {
    expect(closingBriefLines({ ...base, unpaid: { count: 1, totals: { GBP: 50 } } })[0]).toContain("50 GBP")
  })

  it("the wizard's check line becomes the red warning; no line means no warning", () => {
    expect(closingWarning({ ...base, checkNote: "This closure is linked to A, but the client wrote B." })).toBe("This closure is linked to A, but the client wrote B.")
    expect(closingWarning({ ...base, checkNote: "   " })).toBeNull()
    expect(closingWarning(base)).toBeNull()
  })
})

describe("checkNoteFrom", () => {
  it("takes the text after CHECK: from the latest note that has it", () => {
    const notes = [{ body: "Closure wizard: package filed in the person's folder. CHECK: This closure is linked to A, but the client wrote B." }, { body: "older. CHECK: stale" }]
    expect(checkNoteFrom(notes)).toBe("This closure is linked to A, but the client wrote B.")
  })

  it("returns null when no note has a check line, or the line is empty", () => {
    expect(checkNoteFrom([])).toBeNull()
    expect(checkNoteFrom([{ body: "Closure wizard: package filed in the company's storage." }, { body: null }])).toBeNull()
    expect(checkNoteFrom([{ body: "x CHECK:   " }])).toBeNull()
  })
})
