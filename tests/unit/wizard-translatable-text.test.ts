import { describe, it, expect } from "vitest"
import { getWizardTranslatableText } from "@/lib/portal/wizard-translatable-text"

describe("getWizardTranslatableText", () => {
  const result = getWizardTranslatableText()

  it("includes ordinary field labels", () => {
    expect(result["First Name"]).toBe("First Name")
    expect(result["Last Name"]).toBe("Last Name")
  })

  it("includes step titles and descriptions", () => {
    expect(result["Owner Information"]).toBe("Owner Information")
  })

  it("includes the one safe danger box (a data-upload tip, not a legal warning)", () => {
    const dangerText = Object.keys(result).find(k => k.startsWith("Uploading PDFs is NOT recommended"))
    expect(dangerText).toBeDefined()
  })

  it("NEVER includes any excluded attestation wording — the whole point of this module", () => {
    const keys = Object.keys(result)
    expect(keys.some(k => k.includes("I confirm that all information"))).toBe(false)
    expect(keys.some(k => k.includes("I confirm this information is accurate"))).toBe(false)
    expect(keys.some(k => k.includes("I declare, under my own responsibility"))).toBe(false)
    expect(keys.some(k => k.includes("closure fee does not include"))).toBe(false)
    expect(keys.some(k => k.includes("print them in double copy"))).toBe(false)
  })

  it("NEVER includes the $25,000 related-party warning specifically", () => {
    const keys = Object.keys(result)
    expect(keys.some(k => k.includes("$25,000"))).toBe(false)
  })

  it("still includes the ordinary label for the field that CARRIES the excluded warning (only the warning itself is excluded, not the whole field)", () => {
    // has_related_party_transactions itself is an ordinary compliance
    // question — only its warningOnValue is legally sensitive.
    expect(result["Did your LLC have any transactions with other companies that you own, that your family members own, or that own your LLC?"])
      .toBe("Did your LLC have any transactions with other companies that you own, that your family members own, or that own your LLC?")
  })

  it("produces a non-trivial, real-sized set of phrases", () => {
    expect(Object.keys(result).length).toBeGreaterThan(50)
  })

  it("every key equals its own value (English text used as its own lookup key)", () => {
    for (const [key, value] of Object.entries(result)) {
      expect(value).toBe(key)
    }
  })

  it("includes the hand-listed static UI copy from wizard-client.tsx and wizard-field.tsx (2026-08-24 migration pass), not just FieldConfig-derived content", () => {
    expect(result["Required field"]).toBe("Required field")
    expect(result["Draft saved"]).toBe("Draft saved")
    expect(result["Data submitted successfully!"]).toBe("Data submitted successfully!")
    expect(result["Suggested draft"]).toBe("Suggested draft")
    expect(result["Select country..."]).toBe("Select country...")
  })

  it("keeps the interpolation tokens intact for templated UI strings — the AI translation must NOT be asked to translate a literal count or name", () => {
    expect(result["Member {n}"]).toBe("Member {n}")
    expect(result["Ownership shares must total 100% (currently {pctSum}%)"]).toBe("Ownership shares must total 100% (currently {pctSum}%)")
    expect(result["Upload failed: {files}"]).toBe("Upload failed: {files}")
  })
})
