import { describe, it, expect } from "vitest"
import { isSameOriginJson, needsFreshSecondStep } from "@/lib/storage-app/request-checks"

const h = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null })

describe("cookie routes only answer our own page", () => {
  it("accepts a JSON request from the same host", () => {
    expect(isSameOriginJson(h({ "content-type": "application/json", origin: "https://crm.example.test" }), "crm.example.test")).toBe(true)
    expect(isSameOriginJson(h({ "content-type": "application/json; charset=utf-8", origin: "https://crm.example.test" }), "crm.example.test")).toBe(true)
  })
  it("refuses another origin, a missing JSON type (a plain form post), and a lookalike host", () => {
    expect(isSameOriginJson(h({ "content-type": "application/json", origin: "https://evil.example" }), "crm.example.test")).toBe(false)
    expect(isSameOriginJson(h({ "content-type": "application/x-www-form-urlencoded", origin: "https://crm.example.test" }), "crm.example.test")).toBe(false)
    expect(isSameOriginJson(h({ "content-type": "text/plain", origin: "https://crm.example.test" }), "crm.example.test")).toBe(false)
    expect(isSameOriginJson(h({ "content-type": "application/json", origin: "https://crm.example.test.evil.example" }), "crm.example.test")).toBe(false)
    expect(isSameOriginJson(h({ "content-type": "application/json", origin: "not a url" }), "crm.example.test")).toBe(false)
  })
  it("with no Origin header only a same-origin fetch is accepted", () => {
    expect(isSameOriginJson(h({ "content-type": "application/json", "sec-fetch-site": "same-origin" }), "crm.example.test")).toBe(true)
    expect(isSameOriginJson(h({ "content-type": "application/json", "sec-fetch-site": "cross-site" }), "crm.example.test")).toBe(false)
    expect(isSameOriginJson(h({ "content-type": "application/json" }), "crm.example.test")).toBe(false)
  })
})

describe("approving a Mac needs the real two-step check this session", () => {
  it("an enrolled person who is only at the lower level (remembered browser) must verify again", () => {
    expect(needsFreshSecondStep({ hasVerifiedFactor: true, aal: "aal1" })).toBe(true)
    expect(needsFreshSecondStep({ hasVerifiedFactor: true, aal: null })).toBe(true)
    expect(needsFreshSecondStep({ hasVerifiedFactor: true, aal: "aal2" })).toBe(false)
  })
  it("a person with no authenticator is not asked for one here (the CRM's own gate already decided them)", () => {
    expect(needsFreshSecondStep({ hasVerifiedFactor: false, aal: "aal1" })).toBe(false)
  })
})
