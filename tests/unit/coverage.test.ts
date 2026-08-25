import { describe, it, expect } from "vitest"
import { coverageQuestions, unansweredCoverage, incompleteCoverage, hasStructuralProblem, type CoverageTx } from "@/lib/tax/coverage"

function tx(date: string, bank = "Mercury", type: string | null = "Checking"): CoverageTx {
  return { bank_name: bank, account_type: type, transaction_date: date }
}

describe("coverageQuestions", () => {
  it("full-year account → no questions", () => {
    const txs = Array.from({ length: 12 }, (_, i) => tx(`2025-${String(i + 1).padStart(2, "0")}-15`))
    expect(coverageQuestions(txs, 2025)).toEqual([])
  })

  it("starts in March → leading question listing Jan-Feb", () => {
    const qs = coverageQuestions([tx("2025-03-10"), tx("2025-12-20")], 2025)
    const leading = qs.find(q => q.kind === "leading")!
    expect(leading.months).toEqual(["2025-01", "2025-02"])
    expect(leading.question).toContain("before 2025-03")
  })

  it("ends in October → trailing question (the truncated-tail gap gate 1 cannot see)", () => {
    const qs = coverageQuestions([tx("2025-01-10"), tx("2025-10-05")], 2025)
    const trailing = qs.find(q => q.kind === "trailing")!
    expect(trailing.months).toEqual(["2025-11", "2025-12"])
  })

  it("internal gap → one question naming the missing months", () => {
    const qs = coverageQuestions([tx("2025-01-10"), tx("2025-02-12"), tx("2025-06-01"), tx("2025-12-20")], 2025)
    const internal = qs.find(q => q.kind === "internal")!
    expect(internal.months).toEqual(["2025-03", "2025-04", "2025-05", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11"])
  })

  it("per bank account — a full-year bank asks nothing while a partial one does", () => {
    const full = Array.from({ length: 12 }, (_, i) => tx(`2025-${String(i + 1).padStart(2, "0")}-15`, "Wise"))
    const partial = [tx("2025-06-10", "Mercury")]
    const qs = coverageQuestions([...full, ...partial], 2025)
    expect(qs.every(q => q.bank_key.startsWith("Mercury"))).toBe(true)
    expect(qs.map(q => q.kind).sort()).toEqual(["leading", "trailing"])
  })

  it("empty dataset → no questions (nothing to ask about)", () => {
    expect(coverageQuestions([], 2025)).toEqual([])
  })
})

describe("answers", () => {
  const qs = coverageQuestions([tx("2025-03-10")], 2025)

  it("unanswered questions block; answered ones do not", () => {
    expect(unansweredCoverage(qs, {})).toHaveLength(2)
    const answers = Object.fromEntries(qs.map(q => [q.key, { answer: "no_activity" as const, at: "2026-01-01" }]))
    expect(unansweredCoverage(qs, answers)).toEqual([])
    expect(incompleteCoverage(qs, answers)).toEqual([])
  })

  it("'had activity' answers mark the export incomplete", () => {
    const answers = { [qs[0].key]: { answer: "had_activity" as const, at: "2026-01-01" } }
    expect(incompleteCoverage(qs, answers)).toHaveLength(1)
  })
})

describe("hasStructuralProblem", () => {
  const clean = { ingestFailed: 0, failedFilesOverridden: false, quarantined: 0, unansweredCoverage: 0, incompleteCoverage: 0 }

  it("nothing wrong → false", () => {
    expect(hasStructuralProblem(clean)).toBe(false)
  })

  it("an unreadable file → true", () => {
    expect(hasStructuralProblem({ ...clean, ingestFailed: 1 })).toBe(true)
  })

  it("a staff override on the failed file → false again (honors the existing CRM unlock, never re-blocks a case staff already cleared)", () => {
    expect(hasStructuralProblem({ ...clean, ingestFailed: 1, failedFilesOverridden: true })).toBe(false)
  })

  it("an override with no actual failed file changes nothing — still clean", () => {
    expect(hasStructuralProblem({ ...clean, failedFilesOverridden: true })).toBe(false)
  })

  // 2026-08-25, Antonio: "if there are no statements, means there are no
  // activity" — a leading/trailing/internal gap no longer blocks anything,
  // answered or not. Kept as an input field (still computable/showable) but
  // deliberately excluded from the blocking calculation.
  it("an unanswered coverage question → false — no statement means no activity, not a problem", () => {
    expect(hasStructuralProblem({ ...clean, unansweredCoverage: 1 })).toBe(false)
  })

  it("a coverage question answered 'had activity' (confirmed incomplete) → true — the client SAID there was activity, the opposite of 'no statement, assume none'", () => {
    expect(hasStructuralProblem({ ...clean, incompleteCoverage: 1 })).toBe(true)
  })

  it("multiple problems at once → still just true, not double-counted or falsy", () => {
    expect(hasStructuralProblem({ ingestFailed: 2, failedFilesOverridden: false, quarantined: 0, unansweredCoverage: 3, incompleteCoverage: 1 })).toBe(true)
  })

  it("override does NOT suppress an unrelated coverage problem — only the failed-file leg (incompleteCoverage, the still-blocking leg, not unansweredCoverage which never blocks)", () => {
    expect(hasStructuralProblem({ ingestFailed: 1, failedFilesOverridden: true, quarantined: 0, unansweredCoverage: 1, incompleteCoverage: 1 })).toBe(true)
  })

  it("an override plus only unanswered (non-blocking) coverage → false — nothing left blocking", () => {
    expect(hasStructuralProblem({ ingestFailed: 1, failedFilesOverridden: true, quarantined: 0, unansweredCoverage: 5, incompleteCoverage: 0 })).toBe(false)
  })

  // 2026-08-21, round-3 bug-hunter blocker: a file awaiting a staff format
  // confirmation is neither a plain failure nor a coverage gap (a bank with
  // zero ingested rows generates no coverage question at all) — without this
  // leg, a quarantined-only account reported completely clean.
  it("a quarantined file (format confirmation pending) → true, on its own", () => {
    expect(hasStructuralProblem({ ...clean, quarantined: 1 })).toBe(true)
  })

  it("the failed-file override does NOT suppress a quarantined file — they're different legs with different resolutions", () => {
    expect(hasStructuralProblem({ ...clean, quarantined: 1, failedFilesOverridden: true })).toBe(true)
  })

  it("quarantined + everything else clean → still true (this is the exact real-world shape that shipped broken: zero plain failures, zero coverage gaps, one quarantined file)", () => {
    expect(hasStructuralProblem({ ingestFailed: 0, failedFilesOverridden: false, quarantined: 1, unansweredCoverage: 0, incompleteCoverage: 0 })).toBe(true)
  })
})
