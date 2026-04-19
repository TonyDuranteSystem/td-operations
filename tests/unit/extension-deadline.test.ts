import { describe, it, expect } from "vitest"
import {
  resolveExtensionDeadline,
  formatDeadlineForDisplay,
} from "../../lib/tax/extension-deadline"

describe("resolveExtensionDeadline", () => {
  it("returns the stored value verbatim when present", () => {
    expect(resolveExtensionDeadline("2026-10-15", 2025, "SMLLC")).toBe("2026-10-15")
  })

  it("computes Oct 15 for SMLLC when stored is null", () => {
    expect(resolveExtensionDeadline(null, 2025, "SMLLC")).toBe("2026-10-15")
  })

  it("computes Oct 15 for Corp when stored is null", () => {
    expect(resolveExtensionDeadline(null, 2025, "Corp")).toBe("2026-10-15")
  })

  it("computes Sept 15 for MMLLC partnerships", () => {
    expect(resolveExtensionDeadline(null, 2025, "MMLLC")).toBe("2026-09-15")
  })

  it("computes Sept 15 for S-Corp", () => {
    expect(resolveExtensionDeadline(null, 2025, "S-Corp")).toBe("2026-09-15")
  })

  it("defaults to Oct 15 for unknown return types", () => {
    expect(resolveExtensionDeadline(null, 2025, null)).toBe("2026-10-15")
    expect(resolveExtensionDeadline(null, 2025, undefined)).toBe("2026-10-15")
  })

  it("returns null when tax_year is missing — no guess", () => {
    expect(resolveExtensionDeadline(null, null, "SMLLC")).toBeNull()
    expect(resolveExtensionDeadline(null, undefined, "Corp")).toBeNull()
  })

  it("handles future tax years correctly", () => {
    expect(resolveExtensionDeadline(null, 2028, "SMLLC")).toBe("2029-10-15")
    expect(resolveExtensionDeadline(null, 2028, "MMLLC")).toBe("2029-09-15")
  })
})

describe("formatDeadlineForDisplay", () => {
  it("formats en locale as Month D, YYYY", () => {
    expect(formatDeadlineForDisplay("2026-10-15", "en")).toBe("October 15, 2026")
    expect(formatDeadlineForDisplay("2026-09-15", "en")).toBe("September 15, 2026")
  })

  it("formats it locale as D month YYYY", () => {
    expect(formatDeadlineForDisplay("2026-10-15", "it")).toBe("15 ottobre 2026")
    expect(formatDeadlineForDisplay("2026-09-15", "it")).toBe("15 settembre 2026")
  })

  it("defaults to en when locale omitted", () => {
    expect(formatDeadlineForDisplay("2026-10-15")).toBe("October 15, 2026")
  })

  it("returns empty string for null input", () => {
    expect(formatDeadlineForDisplay(null)).toBe("")
  })

  it("returns input unchanged when unparseable (never renders 'Invalid Date')", () => {
    expect(formatDeadlineForDisplay("not-a-date")).toBe("not-a-date")
    expect(formatDeadlineForDisplay("2026-13-40")).toBe("2026-13-40")
  })
})
