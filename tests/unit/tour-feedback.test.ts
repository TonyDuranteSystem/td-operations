/**
 * The windows tour's feedback box — the safe, pure half (dev job f3f3e237).
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import {
  validateFeedback, defuse, formatFeedbackMessage, FEEDBACK_MAX, FEEDBACK_MIN, FEEDBACK_CHANNEL_SLUG, isCurrentVersion,
} from "@/lib/windows/tour-feedback"
import { TOUR_VERSION } from "@/lib/windows/tour-steps"

const good = { text: "Step 3 did not detect my resize", step: "move-resize", state: "waiting", platform: "mac", viewportWidth: 1440, windowCount: 2, tourVersion: TOUR_VERSION }

describe("validateFeedback", () => {
  it("accepts a normal note and trims it", () => {
    const r = validateFeedback({ ...good, text: "  it was unclear  " })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.text).toBe("it was unclear")
  })
  it("asks for a few words, and refuses a wall of text, with plain reasons", () => {
    const short = validateFeedback({ ...good, text: "a".repeat(FEEDBACK_MIN - 1) })
    expect(short.ok).toBe(false)
    const long = validateFeedback({ ...good, text: "a".repeat(FEEDBACK_MAX + 1) })
    expect(long.ok).toBe(false)
    if (!long.ok) expect(long.error).toMatch(/too long/)
  })
  it("refuses anything that is not what the tour sends", () => {
    for (const bad of [null, "x", 5, { ...good, step: "nope" }, { ...good, state: "weird" }, { ...good, platform: "linux" },
      { ...good, viewportWidth: "wide" }, { ...good, windowCount: -1 }, { ...good, tourVersion: Infinity }, { ...good, text: 5 }]) {
      expect(validateFeedback(bad).ok, JSON.stringify(bad)).toBe(false)
    }
  })
})

describe("defuse", () => {
  it("makes every @ harmless so nothing typed can mention a person or start the AI worker", () => {
    const out = defuse("@claude please look, @ai and @Luca too, a@b")
    expect(out).not.toMatch(/@(?!​)/)
    expect(out).toContain("claude")
  })
  it("redacts client identifiers that someone pastes in", () => {
    const out = defuse("her SSN is 123-45-6789 and email jane@acme.com and EIN 12-3456789")
    expect(out).not.toMatch(/123-45-6789|12-3456789|jane/)
  })
})

describe("formatFeedbackMessage", () => {
  const input = { ...good, step: "move-resize" as const, state: "waiting" as const, platform: "mac" as const }

  it("says who, which step and what state, on what kind of computer — and adds the ONE real mention itself, last", () => {
    const m = formatFeedbackMessage(input, "Luca")
    expect(m).toContain("Windows tour feedback from Luca")
    expect(m).toContain("Step 3 of 8 — Move it and change its size (waiting)")
    expect(m).toContain("Mac")
    expect(m).toContain("screen 1440px wide")
    expect(m).toContain("2 windows open")
    expect(m.trim().endsWith("@Antonio")).toBe(true)
    // the person's own words and name never carry a live mention
    const withAt = formatFeedbackMessage({ ...input, text: "ask @claude to fix @Antonio" }, "@Evil")
    const live = withAt.match(/@(?!​)\w+/g) ?? []
    expect(live).toEqual(["@Antonio"]) // only ours
  })
  it("a note sent from the menu (outside the tour) says so instead of naming a step", () => {
    const m = formatFeedbackMessage({ ...input, step: "none" as const }, "Luca")
    expect(m).toContain("Sent from the menu (not during the tour)")
    expect(m).not.toMatch(/Step \d of/)
    expect(validateFeedback({ ...good, step: "none" }).ok).toBe(true)
  })
  it("uses the singular for one window", () => {
    expect(formatFeedbackMessage({ ...input, windowCount: 1 }, "x")).toContain("1 window open")
  })
  it("never contains a page address or anything from the page", () => {
    expect(formatFeedbackMessage(input, "x")).not.toMatch(/https?:\/\/|\/accounts|\/leads/)
  })
})

describe("version", () => {
  it("knows the current tour version", () => {
    expect(isCurrentVersion(TOUR_VERSION)).toBe(true)
    expect(isCurrentVersion(TOUR_VERSION + 1)).toBe(false)
  })
})

describe("the route", () => {
  const route = readFileSync(join(__dirname, "..", "..", "app", "api", "team", "windows-feedback", "route.ts"), "utf8")

  it("is staff-only", () => {
    expect(route).toMatch(/!user \|\| !isStaffUser\(user\)/)
  })
  it("posts through postTeamMessage (never the worker-starting send route) into the dedicated channel", () => {
    expect(route).toContain("postTeamMessage({ channel: FEEDBACK_CHANNEL_SLUG")
    expect(route).not.toMatch(/\/api\/team\/threads/)
    expect(FEEDBACK_CHANNEL_SLUG).toBe("td-windows-feedback")
  })
  it("says exactly what to create when the channel is missing, instead of creating it", () => {
    expect(route).toContain("is not set up yet")
    expect(route).not.toMatch(/\.insert\(\s*\{[^}]*thread_type/)
  })
  it("stops a repeat and a flood, with plain answers", () => {
    expect(route).toContain("duplicate: true")
    expect(route).toContain("status: 429")
  })
})
