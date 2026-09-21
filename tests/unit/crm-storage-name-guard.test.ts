import { describe, it, expect } from "vitest"
import { validateStorageName } from "@/lib/crm-storage/name-guard"

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
})
