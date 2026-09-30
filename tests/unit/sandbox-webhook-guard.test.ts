import { describe, it, expect } from "vitest"
import { isSandboxBlockedWebhook } from "@/lib/sandbox-webhook-guard"

describe("isSandboxBlockedWebhook", () => {
  it("blocks outside providers' webhooks on sandbox", () => {
    for (const p of ["/api/webhooks/stripe", "/api/webhooks/whop", "/api/webhooks/calendly", "/api/webhooks/agreement-signed", "/api/webhooks"]) {
      expect(isSandboxBlockedWebhook(p)).toBe(true)
    }
  })
  it("allows our own offer-signed step (Antonio 2026-09-27)", () => {
    expect(isSandboxBlockedWebhook("/api/webhooks/offer-signed")).toBe(false)
    expect(isSandboxBlockedWebhook("/api/webhooks/offer-signed/")).toBe(false)
  })
  it("does not match look-alikes", () => {
    expect(isSandboxBlockedWebhook("/api/webhooks/offer-signed-evil")).toBe(true)
  })
  it("non-webhook paths are untouched", () => {
    expect(isSandboxBlockedWebhook("/api/portal/wizard-submit")).toBe(false)
  })
})
