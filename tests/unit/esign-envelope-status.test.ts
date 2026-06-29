import { describe, it, expect } from "vitest"
import { isTerminalEnvelopeStatus, TERMINAL_ENVELOPE_STATUSES } from "@/lib/esign/envelope-status"

describe("isTerminalEnvelopeStatus", () => {
  it("terminal statuses are terminal (incl. declined — the round-4 fix)", () => {
    for (const s of ["voided", "expired", "completed", "declined"]) {
      expect(isTerminalEnvelopeStatus(s)).toBe(true)
    }
    expect(TERMINAL_ENVELOPE_STATUSES).toContain("declined")
  })
  it("active statuses are NOT terminal", () => {
    for (const s of ["draft", "sent", "in_progress"]) {
      expect(isTerminalEnvelopeStatus(s)).toBe(false)
    }
  })
  it("null/empty are not terminal", () => {
    expect(isTerminalEnvelopeStatus(null)).toBe(false)
    expect(isTerminalEnvelopeStatus(undefined)).toBe(false)
    expect(isTerminalEnvelopeStatus("")).toBe(false)
  })
})
