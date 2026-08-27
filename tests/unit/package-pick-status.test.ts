/**
 * lib/offers/package-pick-status.ts — the shared "can staff still undo a
 * client's package pick" rule. Split out on its own (dev job 3c1bb5fa follow-up)
 * so the server enforcement (resetPackagePick) and the CRM undo button read
 * the exact same definition instead of two hand-typed copies that could drift.
 */

import { describe, it, expect } from "vitest"
import { canResetPackagePick } from "@/lib/offers/package-pick-status"

describe("canResetPackagePick", () => {
  it("refuses once the offer is signed", () => {
    expect(canResetPackagePick("signed")).toBe(false)
  })

  it("refuses once the offer is completed", () => {
    expect(canResetPackagePick("completed")).toBe(false)
  })

  it("allows it on a draft offer", () => {
    expect(canResetPackagePick("draft")).toBe(true)
  })

  it("allows it on a sent/viewed offer", () => {
    expect(canResetPackagePick("sent")).toBe(true)
    expect(canResetPackagePick("viewed")).toBe(true)
  })

  it("does NOT block 'expired' — staff may legitimately want to reopen an offer that only lapsed on time", () => {
    expect(canResetPackagePick("expired")).toBe(true)
  })

  it("refuses on 'superseded' (bug-hunter, full E2E QA, 2026-08-27) — the replacement already exists as a separate token, and revise-offer's own contract preserves the original untouched", () => {
    // 'superseded' was structurally unreachable when this file was first written (nothing could
    // ever actually reach that status until the offers_status_check migration fixed the same
    // day) — this assertion used to say `true`, grouped with 'expired' under one test, on the
    // assumption both were "the client-facing pick route's rule, not this one." That reasoning
    // does not hold for 'superseded': unlike an offer that merely lapsed on time, a superseded
    // offer's replacement is a DIFFERENT token, so undoing the old one's pick does not give staff
    // anything useful and directly contradicts "the original is preserved."
    expect(canResetPackagePick("superseded")).toBe(false)
  })

  it("allows it when status is missing entirely", () => {
    expect(canResetPackagePick(null)).toBe(true)
    expect(canResetPackagePick(undefined)).toBe(true)
  })
})
