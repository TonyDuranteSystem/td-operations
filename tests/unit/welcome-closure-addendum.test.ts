import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase-admin", () => ({ supabaseAdmin: {} }))

import {
  pickClosureAddendum,
  shouldAppendClosureAddendum,
  CLOSURE_WELCOME_ADDENDUM_FALLBACK,
} from "@/lib/portal/welcome-message"

describe("closure line on the payment welcome (dev job e2fee7e7)", () => {
  const f = (winnerSlug: string, contractHasClosure: boolean, closureOwed: boolean) =>
    shouldAppendClosureAddendum({ winnerSlug, contractHasClosure, closureOwed })
  it("appended when the contract has a closure, its form is owed, and another service's welcome won", () => {
    expect(f("company_formation", true, true)).toBe(true)
  })
  it("not appended when nothing is owed", () => {
    expect(f("company_formation", true, false)).toBe(false)
  })
  it("not appended for an OLD unrelated owed closure when this contract has none", () => {
    expect(f("tax_return", false, true)).toBe(false)
  })
  it("not appended when the welcome IS the closure one (it already says it)", () => {
    expect(f("closure", true, true)).toBe(false)
  })
  it("uses the catalog text when present, per language", () => {
    const md = { addendum: { en: "EN line", it: "IT line" } }
    expect(pickClosureAddendum(md, "en")).toBe("EN line")
    expect(pickClosureAddendum(md, "it")).toBe("IT line")
  })
  it("falls back to the built-in text when the catalog has none / blank / wrong type", () => {
    expect(pickClosureAddendum(null, "it")).toBe(CLOSURE_WELCOME_ADDENDUM_FALLBACK.it)
    expect(pickClosureAddendum({ addendum: { en: "  " } }, "en")).toBe(CLOSURE_WELCOME_ADDENDUM_FALLBACK.en)
    expect(pickClosureAddendum({ addendum: "x" }, "en")).toBe(CLOSURE_WELCOME_ADDENDUM_FALLBACK.en)
  })
})
