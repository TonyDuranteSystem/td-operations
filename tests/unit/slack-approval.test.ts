/**
 * Unit tests for lib/ai-agent/slack-approval.ts
 *
 * Covers the pure guards (isSixDigitCode, isAuthorizedApprover, approvalScopeKey)
 * and handleSlackApprovalCode's branches (happy path, no-match, ambiguous,
 * rail-disabled, unauthorized). All DB + executor calls are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// --- Mocks (must be declared before importing the module under test) --------

const resultQueue: Array<{ data: unknown; error: unknown }> = []

function builder() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = {}
  const chain = ["from", "select", "insert", "update", "eq", "filter", "in", "order", "limit"]
  chain.forEach((m) => (b[m] = vi.fn(() => b)))
  // Awaiting a chain that ends in a query method pops the next queued result.
  b.then = (resolve: (v: unknown) => void) => resolve(resultQueue.shift() ?? { data: null, error: null })
  // .maybeSingle() pops the next queued result for the update path.
  b.maybeSingle = vi.fn(() => Promise.resolve(resultQueue.shift() ?? { data: null, error: null }))
  return b
}

const sharedBuilder = builder()

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: { from: vi.fn(() => sharedBuilder) },
}))

vi.mock("@/lib/ai-agent/approval-env", () => ({
  currentApprovalEnv: vi.fn(() => "production"),
}))

const executeApproval = vi.fn()
const isApprovalRailEnabled = vi.fn(() => true)
vi.mock("@/lib/ai-agent/approval-executor", () => ({
  executeApproval: (...a: unknown[]) => executeApproval(...a),
  isApprovalRailEnabled: () => isApprovalRailEnabled(),
}))

// ---------------------------------------------------------------------------

import {
  isSixDigitCode,
  isAuthorizedApprover,
  approvalScopeKey,
  handleSlackApprovalCode,
  ANTONIO_SLACK_USER_ID,
} from "@/lib/ai-agent/slack-approval"

const ANTONIO = ANTONIO_SLACK_USER_ID
const NOT_ANTONIO = "U0B9ZUE2Q75"

beforeEach(() => {
  resultQueue.length = 0
  executeApproval.mockReset()
  isApprovalRailEnabled.mockReturnValue(true)
})

// -------------------------------------------------------------------------
// Pure guards
// -------------------------------------------------------------------------

describe("isSixDigitCode", () => {
  it("accepts exactly 6 digits (trimmed)", () => {
    expect(isSixDigitCode("305200")).toBe(true)
    expect(isSixDigitCode("  828031  ")).toBe(true)
  })
  it("rejects anything else", () => {
    expect(isSixDigitCode("30520")).toBe(false)
    expect(isSixDigitCode("3052001")).toBe(false)
    expect(isSixDigitCode("305200 please")).toBe(false)
    expect(isSixDigitCode("create Tobia now")).toBe(false)
    expect(isSixDigitCode("")).toBe(false)
    expect(isSixDigitCode(null)).toBe(false)
    expect(isSixDigitCode(undefined)).toBe(false)
  })
})

describe("isAuthorizedApprover", () => {
  it("only the configured approver passes", () => {
    expect(isAuthorizedApprover(ANTONIO)).toBe(true)
    expect(isAuthorizedApprover(NOT_ANTONIO)).toBe(false)
    expect(isAuthorizedApprover(null)).toBe(false)
    expect(isAuthorizedApprover(undefined)).toBe(false)
  })
})

describe("approvalScopeKey", () => {
  it("top-level → channel; threaded → channel:threadTs", () => {
    expect(approvalScopeKey("C1", null)).toBe("C1")
    expect(approvalScopeKey("C1", "123.456")).toBe("C1:123.456")
  })
})

// -------------------------------------------------------------------------
// handleSlackApprovalCode
// -------------------------------------------------------------------------

describe("handleSlackApprovalCode", () => {
  const baseArgs = { code: "305200", channelId: "C0BA802S9LH", threadTs: "1781803023.150789", slackUserId: ANTONIO }

  it("refuses to act for a non-authorized user (handled=false)", async () => {
    const res = await handleSlackApprovalCode({ ...baseArgs, slackUserId: NOT_ANTONIO })
    expect(res.handled).toBe(false)
    expect(executeApproval).not.toHaveBeenCalled()
  })

  it("happy path: finds one pending proposal → approves → executes", async () => {
    resultQueue.push({ data: [{ id: "m1" }], error: null }) // agent_messages in scope
    resultQueue.push({ data: [{ id: "p1", tool_name: "lead_create" }], error: null }) // pending match
    resultQueue.push({ data: { id: "p1", tool_name: "lead_create" }, error: null }) // approve update
    executeApproval.mockResolvedValue({ id: "p1", status: "executed" })

    const res = await handleSlackApprovalCode(baseArgs)
    expect(res.handled).toBe(true)
    expect(executeApproval).toHaveBeenCalledWith("p1")
    expect(res.message).toContain("lead_create")
    expect(res.message.toLowerCase()).toContain("executed")
  })

  it("no matching pending proposal → handled, no execution", async () => {
    resultQueue.push({ data: [{ id: "m1" }], error: null })
    resultQueue.push({ data: [], error: null }) // no pending match
    const res = await handleSlackApprovalCode(baseArgs)
    expect(res.handled).toBe(true)
    expect(res.message.toLowerCase()).toContain("no pending action")
    expect(executeApproval).not.toHaveBeenCalled()
  })

  it("no agent_messages in thread → handled, nothing changed", async () => {
    resultQueue.push({ data: [], error: null })
    const res = await handleSlackApprovalCode(baseArgs)
    expect(res.handled).toBe(true)
    expect(executeApproval).not.toHaveBeenCalled()
  })

  it("ambiguous (2 proposals same code) → refuses, no execution", async () => {
    resultQueue.push({ data: [{ id: "m1" }], error: null })
    resultQueue.push({ data: [{ id: "p1", tool_name: "lead_create" }, { id: "p2", tool_name: "send_email" }], error: null })
    const res = await handleSlackApprovalCode(baseArgs)
    expect(res.handled).toBe(true)
    expect(res.message.toLowerCase()).toContain("won't guess")
    expect(executeApproval).not.toHaveBeenCalled()
  })

  it("rail disabled → approves but does NOT execute", async () => {
    isApprovalRailEnabled.mockReturnValue(false)
    resultQueue.push({ data: [{ id: "m1" }], error: null })
    resultQueue.push({ data: [{ id: "p1", tool_name: "lead_create" }], error: null })
    resultQueue.push({ data: { id: "p1", tool_name: "lead_create" }, error: null })
    const res = await handleSlackApprovalCode(baseArgs)
    expect(res.handled).toBe(true)
    expect(res.message.toLowerCase()).toContain("paused")
    expect(executeApproval).not.toHaveBeenCalled()
  })

  it("execution failure → reports failure, not success", async () => {
    resultQueue.push({ data: [{ id: "m1" }], error: null })
    resultQueue.push({ data: [{ id: "p1", tool_name: "lead_create" }], error: null })
    resultQueue.push({ data: { id: "p1", tool_name: "lead_create" }, error: null })
    executeApproval.mockResolvedValue({ id: "p1", status: "failed", reason: "tool_error" })
    const res = await handleSlackApprovalCode(baseArgs)
    expect(res.handled).toBe(true)
    expect(res.message).toContain("❌")
    expect(res.message.toLowerCase()).toContain("failed")
  })
})
