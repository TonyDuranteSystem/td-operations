/**
 * Unit tests for lib/members/member-info-kickoff.ts (dev job ef529eaf).
 *
 * Covers the two decision points that caused the original bug and the
 * double-ask regression the council review found:
 *   - The materialization-time kickoff must be MMLLC-only and must not fire
 *     twice for the same request.
 *   - The EIN-received flow's own trigger must recognize an already-answered
 *     (submitted) request, not just "still pending".
 */

import { describe, it, expect } from "vitest"
import {
  decideMemberInfoKickoff,
  buildMemberInfoKickoffMessage,
  decideEinReceivedMemberInfoAction,
  buildEinReceivedMemberInfoMessage,
} from "@/lib/members/member-info-kickoff"

describe("decideMemberInfoKickoff", () => {
  it("sends for a brand-new Multi Member LLC request", () => {
    const d = decideMemberInfoKickoff({
      entityType: "Multi Member LLC",
      requestOutcome: "ok",
      isExistingRequest: false,
    })
    expect(d).toEqual({ shouldSend: true, reason: "new_mmllc_request" })
  })

  it("never sends for a Single Member LLC — the binding no-members-section rule", () => {
    const d = decideMemberInfoKickoff({
      entityType: "Single Member LLC",
      requestOutcome: "ok",
      isExistingRequest: false,
    })
    expect(d.shouldSend).toBe(false)
    expect(d.reason).toBe("not_mmllc")
  })

  it("never sends when entity_type is missing/unresolved — never assume MMLLC", () => {
    const d = decideMemberInfoKickoff({
      entityType: null,
      requestOutcome: "ok",
      isExistingRequest: false,
    })
    expect(d.shouldSend).toBe(false)
    expect(d.reason).toBe("not_mmllc")
  })

  it("does not send again for a reused (existing) request — the retry/idempotency double-notify guard", () => {
    const d = decideMemberInfoKickoff({
      entityType: "Multi Member LLC",
      requestOutcome: "ok",
      isExistingRequest: true,
    })
    expect(d.shouldSend).toBe(false)
    expect(d.reason).toBe("already_requested")
  })

  it("does not send when the request itself failed to create", () => {
    const d = decideMemberInfoKickoff({
      entityType: "Multi Member LLC",
      requestOutcome: "error",
      isExistingRequest: false,
    })
    expect(d.shouldSend).toBe(false)
    expect(d.reason).toBe("request_failed")
  })
})

describe("buildMemberInfoKickoffMessage", () => {
  it("builds an English message for a non-Italian contact", () => {
    const { message, messagePreview } = buildMemberInfoKickoffMessage({
      companyName: "Salemark llc",
      formUrl: "https://portal.tonydurante.us/portal/form/tok/code",
      language: "English",
    })
    expect(message).toContain("Salemark llc")
    expect(message).toContain("https://portal.tonydurante.us/portal/form/tok/code")
    expect(message).toMatch(/officially formed/i)
    expect(messagePreview).toMatch(/add your members/i)
  })

  it("builds an Italian message for an Italian contact, including the messy 'Italiano' spelling", () => {
    const { message, messagePreview } = buildMemberInfoKickoffMessage({
      companyName: "Salemark llc",
      formUrl: "https://portal.tonydurante.us/portal/form/tok/code",
      language: "Italiano",
    })
    expect(message).toContain("Salemark llc")
    expect(message).toMatch(/costituita/i)
    expect(messagePreview).toMatch(/indica i soci/i)
  })

  it("defaults to English for blank/unknown language, never throws", () => {
    const { message } = buildMemberInfoKickoffMessage({
      companyName: "Test LLC",
      formUrl: "https://x",
      language: null,
    })
    expect(message).toMatch(/officially formed/i)
  })
})

describe("decideEinReceivedMemberInfoAction", () => {
  it("skips entirely when the client already submitted at materialization — the double-ask fix", () => {
    expect(decideEinReceivedMemberInfoAction("submitted")).toBe("skip_already_submitted")
  })

  it("reuses the still-open request when one is pending", () => {
    expect(decideEinReceivedMemberInfoAction("pending")).toBe("reuse_pending")
  })

  it("creates a new request when none exists (the original, still-correct fallback path)", () => {
    expect(decideEinReceivedMemberInfoAction(null)).toBe("create_new")
    expect(decideEinReceivedMemberInfoAction(undefined)).toBe("create_new")
  })
})

describe("buildEinReceivedMemberInfoMessage", () => {
  it("includes the EIN and company name, in the contact's language", () => {
    const { message, messagePreview } = buildEinReceivedMemberInfoMessage({
      companyName: "Salemark llc",
      ein: "12-3456789",
      formUrl: "https://portal.tonydurante.us/portal/form/tok/code",
      language: "Italian",
    })
    expect(message).toContain("12-3456789")
    expect(message).toContain("Salemark llc")
    expect(message).toMatch(/EIN.*rilasciato/i)
    expect(messagePreview).toMatch(/EIN ricevuto/i)
  })

  it("falls back to English when the language is empty", () => {
    const { message } = buildEinReceivedMemberInfoMessage({
      companyName: "Test LLC",
      ein: "00-0000000",
      formUrl: "https://x",
      language: "",
    })
    expect(message).toMatch(/has been issued/i)
  })
})
