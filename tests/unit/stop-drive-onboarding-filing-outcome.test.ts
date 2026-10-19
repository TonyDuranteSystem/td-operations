/**
 * Stop Drive S1d: an onboarding setup whose papers were not filed ends FAILED (terminal), never "completed".
 * A member passport held on purpose (the member has no contact yet) is not a failure.
 */
import { describe, it, expect } from "vitest"
import { applyFilingOutcome, filingFailures } from "@/lib/jobs/handlers/onboarding-filing-outcome"

const ok = (name: string) => ({ name, status: "ok", detail: "x" })
const err = (name: string, detail = "boom") => ({ name, status: "error", detail })

describe("applyFilingOutcome", () => {
  it("everything filed -> unchanged (ok stays unset)", () => {
    const r = applyFilingOutcome({ steps: [ok("account_create"), ok("store_uploads"), ok("data_summary_pdf")], summary: "3 ok" })
    expect(r.ok).toBeUndefined(); expect(r.terminal).toBeUndefined()
  })
  it.each(["drive_folder", "store_uploads", "data_summary_pdf", "doc_copy_summary", "member_2_passport"])("a failed %s step -> FAILED, terminal, the summary says what", (name) => {
    const r = applyFilingOutcome({ steps: [ok("account_create"), err(name, "Drive write refused")], summary: "1 ok" })
    expect(r.ok).toBe(false); expect(r.terminal).toBe(true)
    expect(r.summary).toMatch(/^FAILED/); expect(r.summary).toContain(name)
  })
  it("a step that is not about filing (tasks, suite, lease …) does not fail the job here", () => {
    expect(applyFilingOutcome({ steps: [err("suite"), err("task_create")] }).ok).toBeUndefined()
  })
  it("a member passport held on purpose (no contact yet) is NOT a failure", () => {
    const held = err("member_2_passport", "Kept on the submission: this member has no contact yet, so the passport has no person to be filed under")
    expect(filingFailures([held])).toEqual([])
    expect(applyFilingOutcome({ steps: [held] }).ok).toBeUndefined()
  })
  it("the exact case seen in sandbox QA: account created, then the folder step refused -> FAILED", () => {
    const r = applyFilingOutcome({ steps: [ok("account_create"), err("drive_folder", "Drive write refused outside production: target 110NU… is not inside the test Shared Drive.")] })
    expect(r.ok).toBe(false)
  })
})
