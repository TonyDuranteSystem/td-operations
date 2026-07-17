/**
 * Slack staff allow-list for the 🧠 memory-save gate (2026-07-17 council fix:
 * the handler let ANY non-bot Slack user write global memory, stamped "Antonio").
 */

import { describe, it, expect, afterEach } from "vitest"
import { isSlackStaff, slackStaffName } from "@/lib/ai-agent/slack-staff"

const ANTONIO = "U0BAALR4Y4Q"
const LUCA = "U0B9ZUE2Q75"
const CLAUDE_BOT = "U0B9S675WTT"
const GUEST = "U0GUEST1234"

afterEach(() => {
  delete process.env.SLACK_STAFF_USER_IDS
})

describe("isSlackStaff", () => {
  it("accepts known staff (Antonio, Luca)", () => {
    expect(isSlackStaff(ANTONIO)).toBe(true)
    expect(isSlackStaff(LUCA)).toBe(true)
  })
  it("rejects the Claude bot, a guest, null, empty", () => {
    expect(isSlackStaff(CLAUDE_BOT)).toBe(false)
    expect(isSlackStaff(GUEST)).toBe(false)
    expect(isSlackStaff(null)).toBe(false)
    expect(isSlackStaff(undefined)).toBe(false)
    expect(isSlackStaff("")).toBe(false)
  })
  it("honors env-added staff ids without a deploy", () => {
    expect(isSlackStaff(GUEST)).toBe(false)
    process.env.SLACK_STAFF_USER_IDS = `${GUEST}, U0OTHER`
    expect(isSlackStaff(GUEST)).toBe(true)
    expect(isSlackStaff("U0OTHER")).toBe(true)
  })
  it("never accepts the bot even if env tries to add it", () => {
    process.env.SLACK_STAFF_USER_IDS = CLAUDE_BOT
    expect(isSlackStaff(CLAUDE_BOT)).toBe(false)
  })
})

describe("slackStaffName", () => {
  it("returns the real reactor name, never a hardcoded Antonio", () => {
    expect(slackStaffName(ANTONIO)).toBe("Antonio")
    expect(slackStaffName(LUCA)).toBe("Luca")
  })
  it("returns null for non-staff", () => {
    expect(slackStaffName(GUEST)).toBeNull()
    expect(slackStaffName(CLAUDE_BOT)).toBeNull()
    expect(slackStaffName(null)).toBeNull()
  })
  it("uses a neutral label for an env-added staff id with no known name", () => {
    process.env.SLACK_STAFF_USER_IDS = "U0NEWSTAFF"
    expect(slackStaffName("U0NEWSTAFF")).toBe("TD Team")
  })
})
