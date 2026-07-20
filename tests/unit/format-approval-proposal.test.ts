/**
 * Hermes ↔ Claude bridge — Phase 2, Slice 4: approval proposal formatter.
 *
 * Pins the plain-text shape Hermes presents to Antonio on Telegram. The
 * formatter is pure (no DB), so these tests just feed it approval_queue-shaped
 * rows and assert on the rendered string: header + short id, tool label, the
 * SURFACED params (and only those), risk flags from APPROVABLE_TOOL_CONSTRAINTS,
 * rationale, and the APPROVE/REJECT instructions. Missing params are handled
 * gracefully.
 */

import { describe, it, expect } from "vitest"
import {
  formatApprovalProposal,
  formatApprovalOutcome,
  formatProposeNotification,
  shortId,
} from "@/lib/ai-agent/format-approval-proposal"

const FULL_UUID = "a1b2c3d4-5e6f-7890-abcd-ef1234567890"

describe("shortId", () => {
  it("is the first 8 chars of the UUID", () => {
    expect(shortId(FULL_UUID)).toBe("a1b2c3d4")
    expect(shortId(FULL_UUID).length).toBe(8)
  })

  it("does not throw on empty input", () => {
    expect(shortId("")).toBe("")
  })
})

describe("formatApprovalProposal — update_account_notes (all surface params)", () => {
  const out = formatApprovalProposal({
    id: FULL_UUID,
    tool_name: "update_account_notes",
    params: {
      account_id: "acc-123",
      note: "Client asked about the EIN",
      // a non-surfaced extra key — must NOT appear
      description: "internal only, should be hidden",
    },
    rationale: "Client asked when the EIN will arrive.",
  })

  it("renders header with 8-char short id", () => {
    expect(out).toContain("📋 Action Proposal #a1b2c3d4")
  })

  it("renders the tool label from constraints, not the raw name", () => {
    expect(out).toContain("🔧 Append note to account")
    expect(out).not.toContain("🔧 update_account_notes")
  })

  it("surfaces every surface param present", () => {
    expect(out).toContain("account_id: acc-123")
    expect(out).toContain("note: Client asked about the EIN")
  })

  it("hides params not in the surface list", () => {
    expect(out).not.toContain("internal only, should be hidden")
    expect(out).not.toContain("description:")
  })

  it("shows the rationale", () => {
    expect(out).toContain("💡 Client asked when the EIN will arrive.")
  })

  it("has no risk flag line (update_account_notes carries no flags)", () => {
    expect(out).not.toContain("⚠️")
  })

  it("includes APPROVE/REJECT instructions with the short id", () => {
    expect(out).toContain("To approve: APPROVE a1b2c3d4")
    expect(out).toContain("To reject: REJECT a1b2c3d4 <reason>")
  })
})

describe("formatApprovalProposal — send_email (external flag)", () => {
  const out = formatApprovalProposal({
    id: FULL_UUID,
    tool_name: "send_email",
    params: {
      to: "client@example.com",
      subject: "Your EIN is ready",
      body: "Hello,\n\nYour EIN has arrived. Please log in to the portal.\n\nBest,\nTD",
    },
    rationale: "EIN received — notify the client.",
  })

  it("flags External recipient AND Irreversible (send_email has both)", () => {
    expect(out).toContain("⚠️")
    expect(out).toContain("External recipient")
    expect(out).toContain("Irreversible")
  })

  it("surfaces to/subject/body", () => {
    expect(out).toContain("to: client@example.com")
    expect(out).toContain("subject: Your EIN is ready")
    expect(out).toContain("body:")
  })

  it("collapses newlines in the body onto one line", () => {
    const bodyLine = out.split("\n").find((l) => l.includes("body:")) ?? ""
    expect(bodyLine).toContain("Hello,")
    expect(bodyLine).toContain("Best, TD")
    // the raw multi-line body must not survive as separate lines
    expect(out).not.toContain("\n\nYour EIN has arrived")
  })
})

describe("formatApprovalProposal — advance_service_stage (cascade flag)", () => {
  const out = formatApprovalProposal({
    id: FULL_UUID,
    tool_name: "advance_service_stage",
    params: {
      service_id: "svc-99",
      notes: "EIN obtained, moving to banking",
    },
    rationale: "Stage complete.",
  })

  it("flags Cascades", () => {
    expect(out).toContain("⚠️")
    expect(out).toContain("Cascades")
  })

  it("does not flag External recipient (not an external action)", () => {
    expect(out).not.toContain("External recipient")
  })

  it("renders the advance label and surfaced params", () => {
    expect(out).toContain("🔧 Advance service stage")
    expect(out).toContain("service_id: svc-99")
    expect(out).toContain("notes: EIN obtained, moving to banking")
  })
})

describe("formatApprovalProposal — graceful handling of missing data", () => {
  it("renders a placeholder when no surface params are present", () => {
    const out = formatApprovalProposal({
      id: FULL_UUID,
      tool_name: "update_account_notes",
      params: {},
      rationale: null,
    })
    expect(out).toContain("🔧 Append note to account")
    expect(out).toContain("(no parameters)")
  })

  it("omits the rationale line when rationale is null/empty", () => {
    const out = formatApprovalProposal({
      id: FULL_UUID,
      tool_name: "update_account_notes",
      params: { account_id: "a1111111-2222-4333-8444-555555555555", note: "x" },
      rationale: null,
    })
    expect(out).not.toContain("💡")
  })

  it("handles null params without throwing", () => {
    const out = formatApprovalProposal({
      id: FULL_UUID,
      tool_name: "update_contact",
      params: null,
      rationale: "test",
    })
    expect(out).toContain("(no parameters)")
    expect(out).toContain("To approve: APPROVE a1b2c3d4")
  })

  it("skips surface params that are absent, shows those present", () => {
    const out = formatApprovalProposal({
      id: FULL_UUID,
      tool_name: "update_account_notes",
      // only the surfaced note/account_id present; other tools' surface keys absent
      params: { account_id: "a1111111-2222-4333-8444-555555555555", note: "Only this one" },
      rationale: "r",
    })
    expect(out).toContain("note: Only this one")
    expect(out).not.toContain("contact_id:")
    expect(out).not.toContain("channel:")
  })

  it("falls back to the raw tool name and surfaces all params for an unknown tool", () => {
    const out = formatApprovalProposal({
      id: FULL_UUID,
      tool_name: "some_future_tool",
      params: { foo: "bar", count: 3 },
      rationale: "r",
    })
    expect(out).toContain("🔧 some_future_tool")
    expect(out).toContain("foo: bar")
    expect(out).toContain("count: 3")
    // unknown tool → no constraint → no risk flags
    expect(out).not.toContain("⚠️")
  })

  it("truncates a very long value with an ellipsis", () => {
    const longBody = "x".repeat(1000)
    const out = formatApprovalProposal({
      id: FULL_UUID,
      tool_name: "send_email",
      params: { to: "a@b.com", subject: "s", body: longBody },
      rationale: "r",
    })
    expect(out).toContain("…")
    // the full 1000-char string must not appear verbatim
    expect(out).not.toContain(longBody)
  })
})

describe("formatApprovalOutcome (Phase B)", () => {
  it("renders the executed header, tool block, and detail line — no APPROVE/REJECT", () => {
    const out = formatApprovalOutcome(
      { id: FULL_UUID, tool_name: "update_account_notes", params: { account_id: "acc-9", note: "Call client" } },
      "executed",
      "Proposal update_account_notes executed successfully.",
    )
    expect(out).toContain(`✅ Action executed #${shortId(FULL_UUID)}`)
    expect(out).toContain("🔧 Append note to account")
    expect(out).toContain("note: Call client")
    expect(out).toContain("📄 Proposal update_account_notes executed successfully.")
    // It already happened — no decision instructions.
    expect(out).not.toContain("APPROVE")
    expect(out).not.toContain("REJECT")
  })

  it("uses the right header emoji per terminal status", () => {
    const base = { id: FULL_UUID, tool_name: "update_account_notes", params: { account_id: "a1111111-2222-4333-8444-555555555555", note: "x" } }
    expect(formatApprovalOutcome(base, "failed")).toContain("❌ Action failed")
    expect(formatApprovalOutcome(base, "rejected")).toContain("🛑 Action rejected")
    expect(formatApprovalOutcome(base, "expired")).toContain("⌛ Action expired")
  })

  it("keeps the risk flags for an external send and omits an empty detail", () => {
    const out = formatApprovalOutcome(
      { id: FULL_UUID, tool_name: "send_email", params: { to: "a@b.c", subject: "S", body: "B" } },
      "failed",
      "  ",
    )
    expect(out).toContain("⚠️ External recipient / Irreversible")
    expect(out).not.toContain("📄")
  })
})

describe("formatProposeNotification (Phase B)", () => {
  it("prefixes the awaiting-approval banner above the full proposal card", () => {
    const out = formatProposeNotification({
      id: FULL_UUID,
      tool_name: "update_account_notes",
      params: { account_id: "acc-9", note: "Call client" },
      rationale: "client asked",
    })
    expect(out).toContain("🆕 New action proposed — awaiting approval")
    expect(out).toContain(`📋 Action Proposal #${shortId(FULL_UUID)}`)
    expect(out).toContain("🔧 Append note to account")
    // Staff can act from the card.
    expect(out).toContain(`APPROVE ${shortId(FULL_UUID)}`)
  })
})
