import { describe, it, expect } from "vitest"
import { NextRequest } from "next/server"
import { timingSafeStrEqual, accessCodeError } from "@/lib/esign/access-guard"

const reqFrom = (ip: string) =>
  new NextRequest("https://t/api/sign/tok/fetch", { headers: { "x-forwarded-for": ip } })

describe("timingSafeStrEqual", () => {
  it("true for equal strings", () => expect(timingSafeStrEqual("abc123", "abc123")).toBe(true))
  it("false for different strings", () => expect(timingSafeStrEqual("abc123", "abc124")).toBe(false))
  it("false for different lengths (no throw)", () => expect(timingSafeStrEqual("abc", "abcdef")).toBe(false))
  it("handles empty / nullish", () => {
    expect(timingSafeStrEqual("", "")).toBe(true)
    // @ts-expect-error testing nullish robustness
    expect(timingSafeStrEqual(undefined, "x")).toBe(false)
  })
})

describe("accessCodeError", () => {
  it("preview mode bypasses the code check", () => {
    expect(accessCodeError(reqFrom("1.1.1.1"), { token: "t", expected: "RIGHT", provided: "", isPreview: true })).toBeNull()
  })
  it("correct code → null (allowed)", () => {
    expect(accessCodeError(reqFrom("2.2.2.2"), { token: "tok-ok", expected: "RIGHT", provided: "RIGHT", isPreview: false })).toBeNull()
  })
  it("wrong code → 403", () => {
    const r = accessCodeError(reqFrom("3.3.3.3"), { token: "tok-bad", expected: "RIGHT", provided: "WRONG", isPreview: false })
    expect(r?.status).toBe(403)
  })
  it("locks out after repeated failures (5 wrong → 6th is 429)", () => {
    const ip = "4.4.4.4", token = "tok-lock"
    for (let i = 0; i < 5; i++) {
      const r = accessCodeError(reqFrom(ip), { token, expected: "RIGHT", provided: "WRONG", isPreview: false })
      expect(r?.status).toBe(403)
    }
    const locked = accessCodeError(reqFrom(ip), { token, expected: "RIGHT", provided: "WRONG", isPreview: false })
    expect(locked?.status).toBe(429)
    // Even a CORRECT code is refused while locked (separate IP+token is unaffected).
    const stillLocked = accessCodeError(reqFrom(ip), { token, expected: "RIGHT", provided: "RIGHT", isPreview: false })
    expect(stillLocked?.status).toBe(429)
    expect(accessCodeError(reqFrom("5.5.5.5"), { token, expected: "RIGHT", provided: "RIGHT", isPreview: false })).toBeNull()
  })
})
