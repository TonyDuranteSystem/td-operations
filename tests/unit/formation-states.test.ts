import { describe, it, expect } from "vitest"
import {
  FORMATION_STATE_CODES,
  FORMATION_STATE_NAMES,
  DEFAULT_FORMATION_STATE,
  isFormationStateCode,
  normalizeFormationState,
  formationStateFromWizardData,
  resolveFormationStateCode,
} from "@/lib/formation/states"

describe("formation states — single source of truth (WS-B, dev job c0a61e44)", () => {
  it("exposes exactly the four supported codes, each with a display name", () => {
    expect([...FORMATION_STATE_CODES]).toEqual(["NM", "WY", "FL", "DE"])
    for (const code of FORMATION_STATE_CODES) {
      expect(FORMATION_STATE_NAMES[code]).toBeTruthy()
    }
    expect(FORMATION_STATE_NAMES.WY).toBe("Wyoming")
  })

  it("default is NM (documented system default)", () => {
    expect(DEFAULT_FORMATION_STATE).toBe("NM")
  })

  describe("isFormationStateCode", () => {
    it("accepts exact codes only", () => {
      expect(isFormationStateCode("WY")).toBe(true)
      expect(isFormationStateCode("wy")).toBe(false)
      expect(isFormationStateCode("Wyoming")).toBe(false)
      expect(isFormationStateCode(null)).toBe(false)
      expect(isFormationStateCode(42)).toBe(false)
    })
  })

  describe("normalizeFormationState", () => {
    it("normalizes codes case/whitespace-insensitively", () => {
      expect(normalizeFormationState(" wy ")).toBe("WY")
      expect(normalizeFormationState("NM")).toBe("NM")
      expect(normalizeFormationState("fl")).toBe("FL")
    })
    it("normalizes full names and embedded names (the SD flow-advance cases)", () => {
      expect(normalizeFormationState("Wyoming")).toBe("WY")
      expect(normalizeFormationState("NEW MEXICO")).toBe("NM")
      expect(normalizeFormationState("State of Florida")).toBe("FL")
      expect(normalizeFormationState("delaware")).toBe("DE")
    })
    it("returns null for junk, empty, and non-strings — never guesses", () => {
      expect(normalizeFormationState("Texas")).toBe(null)
      expect(normalizeFormationState("")).toBe(null)
      expect(normalizeFormationState("   ")).toBe(null)
      expect(normalizeFormationState(null)).toBe(null)
      expect(normalizeFormationState(undefined)).toBe(null)
      expect(normalizeFormationState(7)).toBe(null)
      expect(normalizeFormationState({})).toBe(null)
    })
    it("does not false-match substrings of unrelated words", () => {
      // "NY" is not supported and must not fuzzy-match anything
      expect(normalizeFormationState("NY")).toBe(null)
      expect(normalizeFormationState("New York")).toBe(null)
    })
  })

  describe("formationStateFromWizardData", () => {
    it("reads the three historical wizard keys in order", () => {
      expect(formationStateFromWizardData({ formation_state: "WY" })).toBe("WY")
      expect(formationStateFromWizardData({ state_of_formation: "Florida" })).toBe("FL")
      expect(formationStateFromWizardData({ state_of_incorporation: "delaware" })).toBe("DE")
    })
    it("first present key wins", () => {
      expect(
        formationStateFromWizardData({ formation_state: "WY", state_of_formation: "FL" }),
      ).toBe("WY")
    })
    it("null/absent wizard data → null (wizard rarely captures state)", () => {
      expect(formationStateFromWizardData(null)).toBe(null)
      expect(formationStateFromWizardData(undefined)).toBe(null)
      expect(formationStateFromWizardData({})).toBe(null)
      expect(formationStateFromWizardData({ formation_state: "" })).toBe(null)
    })
  })

  describe("resolveFormationStateCode — authority order wizard → submission → offer → NM", () => {
    it("wizard wins over everything", () => {
      expect(
        resolveFormationStateCode({ wizardState: "WY", submissionState: "FL", offerState: "DE" }),
      ).toEqual({ code: "WY", source: "wizard" })
    })
    it("submission wins over offer when wizard is silent", () => {
      expect(
        resolveFormationStateCode({ wizardState: null, submissionState: "FL", offerState: "DE" }),
      ).toEqual({ code: "FL", source: "submission" })
    })
    it("offer state is used when wizard and submission are silent — the WS-B fix", () => {
      expect(
        resolveFormationStateCode({ wizardState: undefined, submissionState: "", offerState: "WY" }),
      ).toEqual({ code: "WY", source: "offer" })
    })
    it("falls back to NM default when nothing captured a state (current behavior preserved)", () => {
      expect(resolveFormationStateCode({})).toEqual({ code: "NM", source: "default" })
    })
    it("invalid values at a higher tier fall through, never block a lower tier", () => {
      expect(
        resolveFormationStateCode({ wizardState: "Texas", submissionState: "junk", offerState: "WY" }),
      ).toEqual({ code: "WY", source: "offer" })
    })
  })
})
