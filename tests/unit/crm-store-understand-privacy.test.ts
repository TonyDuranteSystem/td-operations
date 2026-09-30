import { describe, it, expect } from "vitest"
import { maskIds, ownerTokens, textNamesOwner } from "@/lib/crm-store/understand/privacy"

describe("hiding ID numbers", () => {
  it.each([
    ["SSN 123-45-6789 issued", "SSN [number] issued"],
    ["EIN 32-0668547 assigned", "EIN [number] assigned"],
    ["Passport YA1234567 valid", "Passport [number] valid"],
    ["Account 1234 5678 9012 3456", "Account [number]"],
    ["Tel 3471234567 call", "Tel [number] call"],
  ])("%s", (a, b) => expect(maskIds(a)).toBe(b))
  it("ordinary numbers and dates stay", () => expect(maskIds("Effective 03/10/2024, rent 150 dollars, 4 pages")).toBe("Effective 03/10/2024, rent 150 dollars, 4 pages"))
})

describe("does a document name the storage's owner", () => {
  it("a company's name is found whatever the legal suffix or case", () => {
    expect(textNamesOwner("between Tony Durante LLC and Dieci Dieci Company L.L.C.", "DIECI DIECI COMPANY LLC")).toBe(true)
  })
  it("a person's name is found in either order (passport MRZ prints the surname first)", () => {
    expect(textNamesOwner("P<ITACERBONE<<MARIO<<<<", "Mario Cerbone")).toBe(true)
  })
  it("another client's document does not name this owner", () => expect(textNamesOwner("Certificate of formation of ZZ Other Company LLC", "DIECI DIECI COMPANY LLC")).toBe(false))
  it("generic words ('LLC', 'Inc') never identify anyone", () => { expect(ownerTokens("LLC Inc")).toEqual([]); expect(textNamesOwner("anything LLC", "LLC")).toBeNull() })
  it("the AI's company answer can vouch when the text spells the name differently", () => expect(textNamesOwner("Dieci-Dieci Co", "DIECI DIECI COMPANY LLC", "Dieci Dieci Company LLC")).toBe(true))
})
