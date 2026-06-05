/**
 * Hermes ↔ Claude bridge — Phase D: approval env lane resolution.
 * Pairs with lib/ai-agent/approval-env.ts.
 *
 * Pins the precedence APPROVAL_ENV → NODE_ENV → 'production' that keeps the
 * proposer and executor in agreement (and defaults the whole rail to
 * 'production' on every real deployment).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { currentApprovalEnv } from "@/lib/ai-agent/approval-env"

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  delete process.env.APPROVAL_ENV
  delete process.env.NODE_ENV
})
afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("currentApprovalEnv", () => {
  it("prefers APPROVAL_ENV when set", () => {
    process.env.APPROVAL_ENV = "staging"
    process.env.NODE_ENV = "production"
    expect(currentApprovalEnv()).toBe("staging")
  })

  it("falls back to NODE_ENV when APPROVAL_ENV is unset", () => {
    process.env.NODE_ENV = "development"
    expect(currentApprovalEnv()).toBe("development")
  })

  it("defaults to 'production' when neither is set (matches the column default)", () => {
    expect(currentApprovalEnv()).toBe("production")
  })

  it("ignores an empty/whitespace APPROVAL_ENV and falls through", () => {
    process.env.APPROVAL_ENV = "   "
    process.env.NODE_ENV = "production"
    expect(currentApprovalEnv()).toBe("production")
  })

  it("never returns an empty string", () => {
    process.env.APPROVAL_ENV = ""
    expect(currentApprovalEnv().length).toBeGreaterThan(0)
  })
})
