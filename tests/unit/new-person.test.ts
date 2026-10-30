/**
 * A person who paid but is not in the CRM. Break the name check and the "too short" test fails; let a
 * typed-but-wrong email through and the email test fails; stop trimming the reference off the payer line and
 * the prefill test fails.
 */
import { describe, it, expect } from "vitest"
import { normalizeEmail, splitPersonName, validateNewPerson, prefillPersonName } from "@/lib/finance/new-person"

describe("normalizeEmail", () => {
  it("lower-cases and trims a real address", () => {
    expect(normalizeEmail("  Simone.Fattor@Example.COM ")).toBe("simone.fattor@example.com")
  })
  it("returns null for empty, non-text and malformed values", () => {
    expect(normalizeEmail("")).toBeNull()
    expect(normalizeEmail(null)).toBeNull()
    expect(normalizeEmail(42)).toBeNull()
    expect(normalizeEmail("no-at-sign")).toBeNull()
    expect(normalizeEmail("a@b")).toBeNull()
    expect(normalizeEmail("a b@c.com")).toBeNull()
    expect(normalizeEmail(`${"a".repeat(250)}@x.com`)).toBeNull()
  })
})

describe("splitPersonName", () => {
  it("splits first and last, keeping a multi-word last name together", () => {
    expect(splitPersonName("Simone Fattor")).toEqual({ first_name: "Simone", last_name: "Fattor" })
    expect(splitPersonName("Mary Ann Smith")).toEqual({ first_name: "Mary", last_name: "Ann Smith" })
  })
  it("has no last name for a single word", () => {
    expect(splitPersonName("Madonna")).toEqual({ first_name: "Madonna", last_name: null })
  })
})

describe("validateNewPerson", () => {
  it("accepts a name alone — the email is optional", () => {
    const r = validateNewPerson({ full_name: "  Simone   Fattor ", email: "" })
    expect(r).toEqual({ ok: true, value: { full_name: "Simone Fattor", first_name: "Simone", last_name: "Fattor", email: null } })
  })
  it("normalises a good email", () => {
    const r = validateNewPerson({ full_name: "Simone Fattor", email: "S@Fattor.IT" })
    expect(r.ok && r.value.email).toBe("s@fattor.it")
  })
  it("refuses a missing, one-letter or too-long name, with a sentence for the screen", () => {
    expect(validateNewPerson(null)).toEqual({ ok: false, error: "Enter the person's name." })
    expect(validateNewPerson({ full_name: "S" })).toEqual({ ok: false, error: "Enter the person's name." })
    const long = validateNewPerson({ full_name: "x".repeat(121) })
    expect(long.ok === false && long.error).toMatch(/too long/)
  })
  it("refuses an email that is typed but wrong instead of silently dropping it", () => {
    const r = validateNewPerson({ full_name: "Simone Fattor", email: "simone@" })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/email/i)
  })
})

describe("prefillPersonName", () => {
  it("uses a plain payer name as it is", () => {
    expect(prefillPersonName("Simone Fattor")).toBe("Simone Fattor")
  })
  it("prefers the processor's own payer field when there is one", () => {
    expect(prefillPersonName("Whatever the bank wrote", "Simone Fattor")).toBe("Simone Fattor")
  })
  it("takes the name between 'From' and 'Via' out of a long bank line", () => {
    expect(prefillPersonName("WISE US INC; INV-001301; TONY DURANTE LLC; From Digital nudge OU Via WISE; Merchant name: WISE US INC"))
      .toBe("Digital nudge OU")
  })
  it("drops a trailing statement reference", () => {
    expect(prefillPersonName("Simone Fattor — 010F1102614929UT_1")).toBe("Simone Fattor")
  })
  it("returns nothing when the line names nobody", () => {
    expect(prefillPersonName("Unknown")).toBe("")
    expect(prefillPersonName("")).toBe("")
    expect(prefillPersonName(null, null)).toBe("")
    expect(prefillPersonName("x")).toBe("")
  })
})
