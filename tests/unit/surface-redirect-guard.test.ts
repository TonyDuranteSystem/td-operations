/**
 * Catching "go run it over there" for an action that is off everywhere (dev job 74701b48).
 *
 * The capability block already tells the worker, in the system prompt, that approval-tier
 * actions are off on EVERY surface, and even names the Slack bot as a thing not to
 * suggest. On the very next deploy it answered: "Your best route is the Slack bot —
 * paste that there and it'll go through the approval flow." It will not.
 *
 * That is the third time in this project a sentence in a prompt failed to stop a
 * confident false claim (the PDF download, the offer to send from a screen that cannot
 * send, and this). So it is caught in the reply and the worker is made to answer again.
 * A wrong redirect is worse than a plain refusal: the person loses the trip as well.
 */

import { describe, it, expect } from "vitest"
import { claimsAnotherSurfaceCanAct, buildSurfaceRedirectNudge } from "@/lib/ai-agent/answer-guards"

describe("claimsAnotherSurfaceCanAct", () => {
  it("catches the exact sentence observed in sandbox", () => {
    expect(claimsAnotherSurfaceCanAct(
      "Your best route is the **Slack bot** — paste that there and it'll go through the approval flow. I can't make it work from here."
    )).toBe(true)
  })

  it("catches the other phrasing it used", () => {
    expect(claimsAnotherSurfaceCanAct(
      "Run it from a surface where the approval flow is active (e.g. the Slack bot)"
    )).toBe(true)
    expect(claimsAnotherSurfaceCanAct("You could try the Slack bot instead.")).toBe(true)
    expect(claimsAnotherSurfaceCanAct("Run this from the team chat and it'll work.")).toBe(true)
  })

  it("does NOT fire on ordinary mentions of a surface", () => {
    // The guard must not punish a legitimate answer that happens to mention Slack.
    for (const ok of [
      "The client replied in the portal chat yesterday.",
      "I found the thread in team chat — Luca asked about the EIN.",
      "That message was posted to the inbox on Tuesday.",
      "I can't run this. Here is exactly what the call would be so you can do it.",
      "",
    ]) {
      expect(claimsAnotherSurfaceCanAct(ok), ok).toBe(false)
    }
  })
})

describe("buildSurfaceRedirectNudge", () => {
  const nudge = buildSurfaceRedirectNudge()

  it("explains why the redirect is worse than a refusal", () => {
    expect(nudge).toMatch(/it will fail there too/i)
    expect(nudge).toMatch(/worse than you simply saying no/i)
  })

  it("tells it what to keep — the lookup is the useful part", () => {
    expect(nudge).toMatch(/keep everything you looked up/i)
  })

  it("names the surfaces it must not point at", () => {
    expect(nudge).toMatch(/Slack, team chat, the inbox, the portal/i)
  })
})
