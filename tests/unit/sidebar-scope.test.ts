/**
 * Business Brain P5 — sidebar-as-worker scope helpers (dev job 203cda1a).
 * The panel derives the client scope from the LIVE route; the server validates it.
 */

import { describe, it, expect } from "vitest"
import { clientKeyFromPath, parseSidebarClientKey } from "@/lib/ai-agent/sidebar-scope"
import { buildWorkerSurfacePrompt } from "@/lib/ai-agent/inbox-worker-prompt"

const UUID = "30c2cd96-03e4-43cf-9536-81d961b18b1d"

describe("clientKeyFromPath", () => {
  it("scopes an account page", () => {
    expect(clientKeyFromPath(`/accounts/${UUID}`)).toBe(`account:${UUID}`)
    expect(clientKeyFromPath(`/accounts/${UUID}/documents`)).toBe(`account:${UUID}`)
  })
  it("scopes a contact page", () => {
    expect(clientKeyFromPath(`/contacts/${UUID}`)).toBe(`contact:${UUID}`)
  })
  it("returns undefined off a client page", () => {
    expect(clientKeyFromPath("/dashboard")).toBeUndefined()
    expect(clientKeyFromPath("/accounts")).toBeUndefined()
    expect(clientKeyFromPath(null)).toBeUndefined()
    expect(clientKeyFromPath("")).toBeUndefined()
  })
})

describe("parseSidebarClientKey", () => {
  it("accepts a well-formed account/contact key", () => {
    expect(parseSidebarClientKey(`account:${UUID}`)).toBe(`account:${UUID}`)
    expect(parseSidebarClientKey(`contact:${UUID}`)).toBe(`contact:${UUID}`)
    expect(parseSidebarClientKey(`  account:${UUID}  `)).toBe(`account:${UUID}`)
  })
  it("rejects anything else (→ no scope)", () => {
    expect(parseSidebarClientKey("lead:" + UUID)).toBeNull()
    expect(parseSidebarClientKey("account:short")).toBeNull()
    expect(parseSidebarClientKey("account:")).toBeNull()
    expect(parseSidebarClientKey("../../etc")).toBeNull()
    expect(parseSidebarClientKey(null)).toBeNull()
    expect(parseSidebarClientKey(42)).toBeNull()
  })
})

describe("dashboard worker prompt", () => {
  it("is the Slack worker persona + a dashboard-assistant override", () => {
    const p = buildWorkerSurfacePrompt("dashboard")
    expect(p).toContain("CRM ASSISTANT")
    expect(p).toContain("left sidebar")
    // discuss-first / no silent writes framing is present
    expect(p.toLowerCase()).toContain("do not silently change")
  })
})
