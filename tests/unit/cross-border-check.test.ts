import { describe, it, expect } from "vitest"
import { detectCrossBorderSignal } from "@/lib/ai-agent/cross-border-check"

describe("detectCrossBorderSignal", () => {
  it("fires on an English cross-border keyword", () => {
    expect(detectCrossBorderSignal(["Do I need to charge VAT in Italy?"])).toBe(true)
  })

  it("fires on an Italian cross-border keyword", () => {
    expect(detectCrossBorderSignal(["Devo pagare le tasse in Italia?"])).toBe(true)
  })

  it("is case-insensitive", () => {
    expect(detectCrossBorderSignal(["What about my VISA status?"])).toBe(true)
  })

  it("does not fire on an ordinary message", () => {
    expect(detectCrossBorderSignal(["Can you resend my invoice?"])).toBe(false)
  })

  it("does not fire on an empty list", () => {
    expect(detectCrossBorderSignal([])).toBe(false)
  })

  it("still detects a keyword within the scan window, not only the very last message", () => {
    const history = ["ok thanks", "Do I owe VAT on this?", "got it"]
    expect(detectCrossBorderSignal(history, 3)).toBe(true)
  })

  it("misses a keyword outside the scan window", () => {
    const history = ["Do I owe VAT on this?", "ok", "thanks", "sounds good"]
    expect(detectCrossBorderSignal(history, 2)).toBe(false)
  })
})
