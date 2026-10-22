import { describe, it, expect } from "vitest"
import { cleanNamePart, composeFullName, validateNameParts } from "@/lib/contacts/contact-name"

describe("contact name: first + last build the full name", () => {
  it("cleans edge spaces and runs of spaces, keeps capitals as typed", () => {
    expect(cleanNamePart("  Di   Lauro ")).toBe("Di Lauro")
    expect(cleanNamePart(null)).toBe("")
    expect(cleanNamePart(undefined)).toBe("")
  })
  it("composes first + last", () => {
    expect(composeFullName("Caterina", "Levoni")).toBe("Caterina Levoni")
    expect(composeFullName("Rodrigo", "Di Lauro")).toBe("Rodrigo Di Lauro")
    expect(composeFullName(" Ana ", " Maria  Silva ")).toBe("Ana Maria Silva")
  })
  it("a one-name person (empty last name) is just the first name", () => {
    expect(composeFullName("Madonna", "")).toBe("Madonna")
    expect(composeFullName("Madonna", null)).toBe("Madonna")
  })
  it("Caterina's old stale pair would have printed wrong — the new pair is right", () => {
    expect(composeFullName("caterina", "")).toBe("caterina")
    expect(composeFullName("Caterina", "Levoni")).toBe("Caterina Levoni")
  })
})

describe("validateNameParts", () => {
  it("accepts a normal name and returns the cleaned parts + the full name", () => {
    expect(validateNameParts(" Caterina ", "Levoni ")).toEqual({ ok: true, first: "Caterina", last: "Levoni", full: "Caterina Levoni" })
  })
  it("accepts an empty last name", () => {
    expect(validateNameParts("Madonna", "")).toEqual({ ok: true, first: "Madonna", last: "", full: "Madonna" })
  })
  it("refuses a missing first name", () => {
    expect(validateNameParts("", "Levoni")).toEqual({ ok: false, error: "First name is required." })
    expect(validateNameParts("   ", "Levoni")).toEqual({ ok: false, error: "First name is required." })
    expect(validateNameParts(null, null).ok).toBe(false)
  })
  it("refuses an absurdly long part", () => {
    const r = validateNameParts("a".repeat(101), "x")
    expect(r.ok).toBe(false)
  })
})
