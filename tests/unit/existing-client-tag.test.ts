import { describe, it, expect } from "vitest"
import { isEstablishedClientContact } from "@/lib/calendly/existing-client-tag"

describe("isEstablishedClientContact", () => {
  it("is true for portal_tier active/formation/onboarding regardless of links", () => {
    expect(isEstablishedClientContact({ portal_tier: "active", hasAccountLink: false, hasServiceDelivery: false })).toBe(true)
    expect(isEstablishedClientContact({ portal_tier: "formation", hasAccountLink: false, hasServiceDelivery: false })).toBe(true)
    expect(isEstablishedClientContact({ portal_tier: "onboarding", hasAccountLink: false, hasServiceDelivery: false })).toBe(true)
  })

  it("is false for portal_tier 'lead' with no other signal", () => {
    expect(isEstablishedClientContact({ portal_tier: "lead", hasAccountLink: false, hasServiceDelivery: false })).toBe(false)
  })

  it("is false for null portal_tier with no other signal (never a denylist misfire)", () => {
    expect(isEstablishedClientContact({ portal_tier: null, hasAccountLink: false, hasServiceDelivery: false })).toBe(false)
  })

  it("is true for null portal_tier when the contact has an account link (co-member case)", () => {
    expect(isEstablishedClientContact({ portal_tier: null, hasAccountLink: true, hasServiceDelivery: false })).toBe(true)
  })

  it("is true for null portal_tier when the contact has a service delivery (contact-only ITIN client)", () => {
    expect(isEstablishedClientContact({ portal_tier: null, hasAccountLink: false, hasServiceDelivery: true })).toBe(true)
  })

  it("is true for portal_tier 'lead' when the contact already has an account link", () => {
    expect(isEstablishedClientContact({ portal_tier: "lead", hasAccountLink: true, hasServiceDelivery: false })).toBe(true)
  })

  it("handles an unexpected/empty-string portal_tier the same as null (allowlist, not denylist)", () => {
    expect(isEstablishedClientContact({ portal_tier: "", hasAccountLink: false, hasServiceDelivery: false })).toBe(false)
    expect(isEstablishedClientContact({ portal_tier: "", hasAccountLink: true, hasServiceDelivery: false })).toBe(true)
  })
})
