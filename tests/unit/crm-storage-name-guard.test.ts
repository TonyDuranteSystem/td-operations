import { describe, it, expect } from "vitest"
import { validateStorageName, escapeIlikePattern } from "@/lib/crm-storage/name-guard"

describe("validateStorageName", () => {
  it("accepts an ordinary name", () => {
    expect(validateStorageName("Tax Returns")).toEqual({ error: null, name: "Tax Returns" })
  })

  it("trims leading and trailing whitespace", () => {
    expect(validateStorageName("  Invoices  ")).toEqual({ error: null, name: "Invoices" })
  })

  it("rejects a non-string input", () => {
    expect(validateStorageName(42).error).toBeTruthy()
  })

  it("rejects an empty string", () => {
    expect(validateStorageName("").error).toBeTruthy()
  })

  it("rejects a string that is only whitespace", () => {
    expect(validateStorageName("   ").error).toBeTruthy()
  })

  it("rejects a forward slash", () => {
    expect(validateStorageName("a/b").error).toBeTruthy()
  })

  it("rejects a backslash", () => {
    expect(validateStorageName("a\\b").error).toBeTruthy()
  })

  it("rejects the current-directory token", () => {
    expect(validateStorageName(".").error).toBeTruthy()
  })

  it("rejects the parent-directory token", () => {
    expect(validateStorageName("..").error).toBeTruthy()
  })

  it("rejects a NUL byte", () => {
    expect(validateStorageName("a\0b").error).toBeTruthy()
  })

  it("rejects a name longer than 255 characters", () => {
    expect(validateStorageName("a".repeat(256)).error).toBeTruthy()
  })

  it("accepts a name exactly 255 characters long", () => {
    const name = "a".repeat(255)
    expect(validateStorageName(name)).toEqual({ error: null, name })
  })

  it("accepts unicode and emoji in a name", () => {
    expect(validateStorageName("📁 Clients 日本語")).toEqual({ error: null, name: "📁 Clients 日本語" })
  })

  it("rejects a name made up of only a zero-width space", () => {
    expect(validateStorageName("​").error).toBeTruthy()
  })

  it("rejects a name made up of only zero-width and invisible characters", () => {
    expect(validateStorageName("​‌﻿").error).toBeTruthy()
  })

  it("accepts a visible name with a stray zero-width character mixed in", () => {
    const result = validateStorageName("Tax​ Returns")
    expect(result.error).toBeNull()
  })

  it("rejects a newline in the name", () => {
    expect(validateStorageName("line1\nline2").error).toBeTruthy()
  })

  it("rejects a tab in the name", () => {
    expect(validateStorageName("a\tb").error).toBeTruthy()
  })

  it("rejects a carriage return in the name", () => {
    expect(validateStorageName("a\rb").error).toBeTruthy()
  })

  it("accepts a percent sign in the name", () => {
    expect(validateStorageName("50% Complete")).toEqual({ error: null, name: "50% Complete" })
  })
})

describe("escapeIlikePattern", () => {
  it("leaves an ordinary name unchanged", () => {
    expect(escapeIlikePattern("Tax Returns")).toBe("Tax Returns")
  })

  it("escapes an underscore so it can't match any single character", () => {
    expect(escapeIlikePattern("test_1")).toBe("test\\_1")
  })

  it("escapes a percent sign so it can't match everything", () => {
    expect(escapeIlikePattern("50%")).toBe("50\\%")
  })

  it("escapes a literal backslash", () => {
    expect(escapeIlikePattern("a\\b")).toBe("a\\\\b")
  })

  it("escapes every occurrence, not just the first", () => {
    expect(escapeIlikePattern("a_b_c%d")).toBe("a\\_b\\_c\\%d")
  })

  it("regression: the bug this closes — an unescaped underscore was a wildcard for any character", () => {
    // "test_1" as a RAW (unescaped) ILIKE pattern matches "testA1" too,
    // because unescaped `_` means "any one character" in SQL LIKE syntax —
    // producing a false "already exists" against a name that isn't actually
    // a duplicate. Once escaped, the `_` is a literal backslash-escaped
    // character in the pattern, not a wildcard.
    const escaped = escapeIlikePattern("test_1")
    expect(escaped).toBe("test\\_1")
    expect(escaped).not.toBe("test_1")
  })
})
