/**
 * Per-surface full-reach switches (dev job 74701b48).
 *
 * This was ONE global variable shared by Slack, Team Chat and the CRM panels, so turning
 * reach on anywhere turned it on everywhere and rolling it back anywhere rolled it back
 * everywhere — including surfaces that were fine. The council asked for independent
 * switches so the riskiest surface can be cut on its own.
 */

import { describe, it, expect, afterEach } from "vitest"
import { fullReachEnabledFor } from "@/lib/ai-agent/full-reach"

const VARS = [
  "WORKER_FULL_REACH_DASHBOARD",
  "WORKER_FULL_REACH_INBOX",
  "WORKER_FULL_REACH_PORTAL_CHAT",
  "WORKER_FULL_REACH_TEAM_CHAT",
  "WORKER_FULL_REACH_SLACK",
  "ASSISTANT_FULL_REACH_ENABLED",
]
afterEach(() => VARS.forEach((v) => delete process.env[v]))

describe("defaults", () => {
  it("every surface is on — the worker has the same capability wherever it is", () => {
    // Antonio, 2026-07-19. Holding Slack and Team Chat back was second-guessing a
    // decision already made; reach grants only lookup, and every dangerous tool now
    // needs approval by name rather than by a guess at its name.
    for (const s of ["dashboard", "inbox", "portal_chat", "team_chat", "slack"] as const) {
      expect(fullReachEnabledFor(s), s).toBe(true)
    }
  })
})

describe("precedence", () => {
  it("a per-surface switch overrides the default", () => {
    process.env.WORKER_FULL_REACH_PORTAL_CHAT = "false"
    expect(fullReachEnabledFor("portal_chat")).toBe(false)
    expect(fullReachEnabledFor("inbox")).toBe(true) // and only that surface
  })

  it("a per-surface switch overrides the legacy global in BOTH directions", () => {
    process.env.ASSISTANT_FULL_REACH_ENABLED = "false"
    process.env.WORKER_FULL_REACH_SLACK = "true"
    expect(fullReachEnabledFor("slack")).toBe(true)
    expect(fullReachEnabledFor("team_chat")).toBe(false) // global still governs the rest

    process.env.ASSISTANT_FULL_REACH_ENABLED = "true"
    process.env.WORKER_FULL_REACH_PORTAL_CHAT = "false"
    expect(fullReachEnabledFor("portal_chat")).toBe(false)
  })

  it("the legacy global can still switch surfaces OFF wholesale", () => {
    process.env.ASSISTANT_FULL_REACH_ENABLED = "false"
    expect(fullReachEnabledFor("slack")).toBe(false)
    expect(fullReachEnabledFor("team_chat")).toBe(false)
  })

  it("KILL SWITCH: one panel can be cut without touching the others", () => {
    process.env.WORKER_FULL_REACH_PORTAL_CHAT = "false"
    expect(fullReachEnabledFor("portal_chat")).toBe(false)
    expect(fullReachEnabledFor("dashboard")).toBe(true)
    expect(fullReachEnabledFor("inbox")).toBe(true)
  })
})

describe("parsing", () => {
  it("only exactly true/false count; anything else is treated as unset", () => {
    // A typo must fall through to the documented default, never be guessed at.
    for (const junk of ["TRUE", "1", "yes", "on", "", "  "]) {
      process.env.WORKER_FULL_REACH_DASHBOARD = junk
      expect(fullReachEnabledFor("dashboard"), junk).toBe(true) // default, not the junk
    }
  })

  it("is whitespace and case tolerant for the values it does accept", () => {
    process.env.WORKER_FULL_REACH_DASHBOARD = " False "
    expect(fullReachEnabledFor("dashboard")).toBe(false)
  })
})
