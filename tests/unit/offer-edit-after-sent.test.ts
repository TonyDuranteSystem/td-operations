/**
 * Claude's offer-edit tool on an offer that is already out (lib/offers/edit-after-sent.ts + lib/mcp/tools/offers.ts,
 * offer builder Part 3 item D): a reason is required and logged — not a ban.
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { editReasonProblem, MIN_EDIT_REASON_LENGTH, statusSetByHandProblem } from "@/lib/offers/edit-after-sent"

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

describe("statusSetByHandProblem — an offer becomes 'sent' only through Send", () => {
  it.each(["draft", "viewed", "signed", "completed", "expired", "superseded"])("'sent' on an offer that is '%s' is refused, in plain words, pointing at offer_send", (currentStatus) => {
    const msg = statusSetByHandProblem({ currentStatus, updates: { status: "sent" } })
    expect(msg).not.toBeNull()
    expect(msg).toContain("Nothing was changed")
    expect(msg).toContain("offer_send")
    expect(msg).toContain("offer_resend")
  })

  it.each(["Sent", "SENT", "  sent  ", " Sent\n"])("the spelling %j is caught too", (status) => {
    expect(statusSetByHandProblem({ currentStatus: "draft", updates: { status } })).not.toBeNull()
  })

  it("an offer whose status cannot be read (not found / lookup failed) is still refused — fail closed", () => {
    expect(statusSetByHandProblem({ currentStatus: undefined, updates: { status: "sent" } })).not.toBeNull()
    expect(statusSetByHandProblem({ currentStatus: null, updates: { status: "sent" } })).not.toBeNull()
  })

  it("re-saving an offer that is ALREADY 'sent' as 'sent' changes nothing, so it is not refused", () => {
    expect(statusSetByHandProblem({ currentStatus: "sent", updates: { status: "sent" } })).toBeNull()
    expect(statusSetByHandProblem({ currentStatus: " Sent ", updates: { status: "SENT" } })).toBeNull()
  })

  it.each(["expired", "draft", "viewed", "signed", "completed", ""])("other statuses ('%s') are left alone — 'expired' is how an old offer is retired", (status) => {
    expect(statusSetByHandProblem({ currentStatus: "draft", updates: { status } })).toBeNull()
  })

  it("an edit with no status in it, or with a status that is not text, is not this check's business", () => {
    expect(statusSetByHandProblem({ currentStatus: "draft", updates: { client_email: "a@b.com" } })).toBeNull()
    expect(statusSetByHandProblem({ currentStatus: "draft", updates: {} })).toBeNull()
    expect(statusSetByHandProblem({ currentStatus: "draft", updates: { status: null } })).toBeNull()
    expect(statusSetByHandProblem({ currentStatus: "draft", updates: { status: 7 } })).toBeNull()
    expect(statusSetByHandProblem({ currentStatus: "draft", updates: null })).toBeNull()
    expect(statusSetByHandProblem({ currentStatus: "draft", updates: undefined })).toBeNull()
  })

  it("a field NAMED like status elsewhere in the object does not count (own key 'status' only)", () => {
    expect(statusSetByHandProblem({ currentStatus: "draft", updates: { notes: { status: "sent" } } })).toBeNull()
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

  it("refuses a hand-set 'sent' BEFORE the reason rule and before any write, and no longer teaches the shortcut in its own help text", () => {
    const hand = block.indexOf("statusSetByHandProblem(")
    expect(hand).toBeGreaterThan(-1)
    expect(block.indexOf("editReasonProblem(")).toBeGreaterThan(hand)
    expect(block.indexOf(".update(updates)")).toBeGreaterThan(hand)
    expect(block).not.toContain("{status: 'sent'")
    expect(block).toContain("use offer_send")
  })

  it("the server instructions and their mirror say the same thing", () => {
    for (const f of ["lib/mcp/instructions.ts", "docs/claude-connector-system-instructions.md"]) {
      const text = readFileSync(join(process.cwd(), f), "utf8")
      expect(text, f).toContain("offer_update also REFUSES to set status to 'sent'")
    }
  })

  it("reads the offer's current status to decide", () => {
    expect(block).toMatch(/\.from\("offers"\)\.select\("status"\)\.eq\("token", token\)/)
  })

  it("writes the reason and the previous status to the activity log for an offer that was out", () => {
    expect(block).toContain("previous_status: current.status")
    expect(block).toContain("reason: (reason ?? \"\").trim()")
  })
})
