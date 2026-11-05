/**
 * Claude's offer-edit tool on an offer that is already out (lib/offers/edit-after-sent.ts + lib/mcp/tools/offers.ts,
 * offer builder Part 3 item D): a reason is required and logged — not a ban.
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { editReasonProblem, MIN_EDIT_REASON_LENGTH } from "@/lib/offers/edit-after-sent"

const REASON = "Currency was typed as EUR at creation, the client agreed USD"

describe("editReasonProblem — when may an edit go ahead?", () => {
  it("a draft needs no reason", () => {
    expect(editReasonProblem({ status: "draft", reason: undefined })).toBeNull()
    expect(editReasonProblem({ status: "draft", reason: "" })).toBeNull()
  })

  it("an offer that was not found is left to the update itself to report", () => {
    expect(editReasonProblem({ status: undefined, reason: undefined })).toBeNull()
    expect(editReasonProblem({ status: null, reason: undefined })).toBeNull()
    expect(editReasonProblem({ status: "  ", reason: undefined })).toBeNull()
  })

  it.each(["sent", "viewed", "signed", "completed", "expired", "superseded"])("an offer that is '%s' needs a reason", (status) => {
    const msg = editReasonProblem({ status, reason: undefined })
    expect(msg).toContain(`"${status}"`)
    expect(msg).toContain("Nothing was changed")
    expect(msg).toContain("Tell Antonio")
    expect(msg).toContain("reason")
  })

  it("a real sentence is accepted for an offer that is out", () => {
    expect(editReasonProblem({ status: "sent", reason: REASON })).toBeNull()
    expect(editReasonProblem({ status: "completed", reason: `  ${REASON}  ` })).toBeNull()
  })

  it("too short, blank, spaces only, or not text is refused", () => {
    for (const reason of ["", "   ", "fix", "x".repeat(MIN_EDIT_REASON_LENGTH - 1), null, undefined, 42, {}, ["a long enough reason here"]]) {
      expect(editReasonProblem({ status: "sent", reason })).not.toBeNull()
    }
  })

  it("the shortest accepted reason is exactly the minimum, counted after trimming", () => {
    expect(editReasonProblem({ status: "sent", reason: "x".repeat(MIN_EDIT_REASON_LENGTH) })).toBeNull()
    expect(editReasonProblem({ status: "sent", reason: `   ${"x".repeat(MIN_EDIT_REASON_LENGTH - 1)}   ` })).not.toBeNull()
  })
})

describe("the offer_update tool uses it", () => {
  const src = readFileSync(join(process.cwd(), "lib/mcp/tools/offers.ts"), "utf8")
  const start = src.indexOf('"offer_update"')
  const block = src.slice(start, src.indexOf("offer_send — Publish offer", start))

  it("takes an optional reason and checks it BEFORE any write", () => {
    expect(block).toContain("reason: z.string().optional()")
    const check = block.indexOf("editReasonProblem(")
    const write = block.indexOf(".update(updates)")
    expect(check).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(check)
    expect(block).toContain("offer_update refused:")
  })

  it("reads the offer's current status to decide", () => {
    expect(block).toMatch(/\.from\("offers"\)\.select\("status"\)\.eq\("token", token\)/)
  })

  it("writes the reason and the previous status to the activity log for an offer that was out", () => {
    expect(block).toContain("previous_status: current.status")
    expect(block).toContain("reason: (reason ?? \"\").trim()")
  })
})
