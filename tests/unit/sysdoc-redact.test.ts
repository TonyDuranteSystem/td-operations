import { describe, it, expect } from "vitest"
import { redactSensitive } from "@/lib/mcp/tools/sysdocs"

describe("redactSensitive (sysdoc_read_allowed defense-in-depth)", () => {
  it("passes clean text through unchanged", () => {
    const input = "This is a normal method doc with no secrets. Step 1, step 2."
    const { text, redacted } = redactSensitive(input)
    expect(redacted).toBe(false)
    expect(text).toBe(input)
  })

  it("redacts an EIN", () => {
    const { text, redacted } = redactSensitive("EIN on file: 12-3456789 for the LLC.")
    expect(redacted).toBe(true)
    expect(text).not.toContain("12-3456789")
    expect(text).toContain("[REDACTED]")
  })

  it("redacts an SSN/ITIN pattern", () => {
    const { text, redacted } = redactSensitive("ITIN 123-45-6789")
    expect(redacted).toBe(true)
    expect(text).not.toContain("123-45-6789")
  })

  it("redacts an email address", () => {
    const { text, redacted } = redactSensitive("contact client@example.com please")
    expect(redacted).toBe(true)
    expect(text).not.toContain("client@example.com")
  })

  it("redacts a Supabase secret key", () => {
    const { text, redacted } = redactSensitive("key=sb_secret_abc123DEF456 here")
    expect(redacted).toBe(true)
    expect(text).not.toContain("sb_secret_abc123DEF456")
  })

  it("redacts a JWT-shaped token", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4"
    const { text, redacted } = redactSensitive(`token ${jwt}`)
    expect(redacted).toBe(true)
    expect(text).not.toContain(jwt)
  })

  it("flags redaction when multiple patterns are present", () => {
    const { redacted } = redactSensitive("EIN 12-3456789 and email a@b.co")
    expect(redacted).toBe(true)
  })
})
