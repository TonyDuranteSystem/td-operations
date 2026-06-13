import { describe, it, expect } from "vitest"
import { calcITINRenewalDate, extractITINMiddleDigits } from "@/lib/itin/renewal-utils"

describe("calcITINRenewalDate", () => {
  it("returns June 1st of issue_year + 3 for a string date", () => {
    const result = calcITINRenewalDate("2021-03-15")
    expect(result).not.toBeNull()
    expect(result!.getFullYear()).toBe(2024)
    expect(result!.getMonth()).toBe(5) // June = 5
    expect(result!.getDate()).toBe(1)
  })

  it("returns June 1st of issue_year + 3 for a Date object", () => {
    const result = calcITINRenewalDate(new Date(2020, 0, 1))
    expect(result!.getFullYear()).toBe(2023)
    expect(result!.getMonth()).toBe(5)
    expect(result!.getDate()).toBe(1)
  })

  it("returns null for null input", () => {
    expect(calcITINRenewalDate(null)).toBeNull()
  })

  it("returns null for undefined input", () => {
    expect(calcITINRenewalDate(undefined)).toBeNull()
  })

  it("returns null for an invalid date string", () => {
    expect(calcITINRenewalDate("not-a-date")).toBeNull()
  })

  it("handles end of year correctly", () => {
    const result = calcITINRenewalDate("2022-12-31")
    expect(result!.getFullYear()).toBe(2025)
    expect(result!.getMonth()).toBe(5)
  })
})

describe("extractITINMiddleDigits", () => {
  it("extracts middle 2 digits from a formatted ITIN", () => {
    expect(extractITINMiddleDigits("912-70-1234")).toBe("70")
    expect(extractITINMiddleDigits("900-88-9999")).toBe("88")
  })

  it("extracts from an unformatted ITIN", () => {
    expect(extractITINMiddleDigits("912701234")).toBe("70")
  })

  it("returns null for null", () => {
    expect(extractITINMiddleDigits(null)).toBeNull()
  })

  it("returns null for undefined", () => {
    expect(extractITINMiddleDigits(undefined)).toBeNull()
  })

  it("returns null for an ITIN that is not 9 digits", () => {
    expect(extractITINMiddleDigits("123-45")).toBeNull()
    expect(extractITINMiddleDigits("123456789012")).toBeNull()
  })

  it("returns null for an empty string", () => {
    expect(extractITINMiddleDigits("")).toBeNull()
  })
})
