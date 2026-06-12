import { describe, it, expect } from "vitest"
import {
  ANTONIO_SLACK_USER_ID,
  ASK_POLL_MS,
  ASK_MAX_WAIT_MS,
  buildQuestionSlackText,
  cleanAnswerText,
  interpretQuestionRow,
  // @ts-expect-error — .mjs module has no type declarations; vitest/esbuild resolves it at runtime.
} from "../../scripts/mac-mini/ask-antonio-lib.mjs"

describe("constants", () => {
  it("Antonio's id matches the one used across the Slack worker + webhook", () => {
    expect(ANTONIO_SLACK_USER_ID).toBe("U0BAALR4Y4Q")
  })
  it("poll + max-wait are sane", () => {
    expect(ASK_POLL_MS).toBe(10_000)
    expect(ASK_MAX_WAIT_MS).toBe(30 * 60 * 1000)
  })
})

describe("buildQuestionSlackText", () => {
  it("formats the question with the reply-in-thread hint", () => {
    const text = buildQuestionSlackText("Name it X or Y?")
    expect(text).toContain("❓ *Claude needs your input:*")
    expect(text).toContain("Name it X or Y?")
    expect(text).toContain("_Reply in this thread to answer._")
  })
  it("trims surrounding whitespace from the question", () => {
    expect(buildQuestionSlackText("  hi  ")).toContain("\nhi\n")
  })
  it("does not throw on empty/undefined", () => {
    expect(() => buildQuestionSlackText("")).not.toThrow()
    expect(() => buildQuestionSlackText(undefined)).not.toThrow()
  })
})

describe("cleanAnswerText", () => {
  it("strips Slack mention tokens and trims", () => {
    expect(cleanAnswerText("<@U0B9S675WTT> use option Y")).toBe("use option Y")
    expect(cleanAnswerText("<@U0BAALR4Y4Q|antonio> sandbox")).toBe("sandbox")
  })
  it("leaves plain text untouched", () => {
    expect(cleanAnswerText("just go with X")).toBe("just go with X")
  })
  it("handles empty/undefined", () => {
    expect(cleanAnswerText("")).toBe("")
    expect(cleanAnswerText(undefined)).toBe("")
  })
})

describe("interpretQuestionRow", () => {
  it("answered → done, exit 0, the answer text", () => {
    expect(interpretQuestionRow({ status: "answered", answer: "use Y" })).toEqual({
      done: true,
      exitCode: 0,
      output: "use Y",
    })
  })
  it("answered but empty answer → a placeholder, still done/exit 0", () => {
    const v = interpretQuestionRow({ status: "answered", answer: "   " })
    expect(v.done).toBe(true)
    expect(v.exitCode).toBe(0)
    expect(v.output).toMatch(/no text/i)
  })
  it("expired → done, exit 0, a proceed-without note", () => {
    const v = interpretQuestionRow({ status: "expired" })
    expect(v.done).toBe(true)
    expect(v.exitCode).toBe(0)
    expect(v.output).toMatch(/expired/i)
  })
  it("pending → not done (keep polling)", () => {
    expect(interpretQuestionRow({ status: "pending" })).toEqual({ done: false })
  })
  it("missing row → not done", () => {
    expect(interpretQuestionRow(null)).toEqual({ done: false })
    expect(interpretQuestionRow(undefined)).toEqual({ done: false })
  })
})
