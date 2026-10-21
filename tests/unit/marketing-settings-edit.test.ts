import { describe, it, expect } from "vitest"
import { buildOptions, cleanChecklist, slugKey } from "@/lib/marketing/settings-edit"

const prev = [{ key: "wrong_profile", label: "Wrong profile" }, { key: "other", label: "Other" }]

describe("slugKey", () => {
  it("makes a stored key from a label", () => {
    expect(slugKey("Lives in Italy, no business")).toBe("lives_in_italy_no_business")
    expect(slugKey("Città lontana!")).toBe("citta_lontana")
    expect(slugKey("   ")).toBe("")
    expect(slugKey("x".repeat(100)).length).toBeLessThanOrEqual(40)
  })
})

describe("buildOptions", () => {
  it("a renamed row keeps its key; a new row gets a new key; a removed row disappears", () => {
    const r = buildOptions(prev, [{ key: "wrong_profile", label: "Wrong profile (edited)" }, { key: null, label: "Too far away" }])
    expect(r).toEqual([{ key: "wrong_profile", label: "Wrong profile (edited)" }, { key: "too_far_away", label: "Too far away" }])
  })
  it("a new row can never take a key an existing row holds, even one made from the same words", () => {
    const r = buildOptions(prev, [{ key: "other", label: "Other" }, { key: null, label: "Other" }, { key: null, label: "Wrong profile" }])
    expect(r?.map(o => o.key)).toEqual(["other", "other_2", "wrong_profile_2"])
  })
  it("two new rows with the same words get different keys", () => {
    expect(buildOptions([], [{ label: "Maybe" }, { label: "Maybe" }])?.map(o => o.key)).toEqual(["maybe", "maybe_2"])
  })
  it("a key the editor invents that is not a known one is ignored", () => {
    expect(buildOptions(prev, [{ key: "evil_key", label: "Fine label" }])).toEqual([{ key: "fine_label", label: "Fine label" }])
  })
  it("blank labels are dropped and nothing left is null", () => {
    expect(buildOptions(prev, [{ key: "other", label: "  " }])).toBeNull()
    expect(buildOptions(prev, [])).toBeNull()
  })
  it("labels are tidied", () => {
    expect(buildOptions(prev, [{ key: "other", label: "  Not   interested  " }])).toEqual([{ key: "other", label: "Not interested" }])
  })
})

describe("cleanChecklist", () => {
  it("trims, drops blanks and repeats (ignoring case), keeps order, caps the length", () => {
    expect(cleanChecklist([" Has a business ", "", "has a business", "Wants an LLC"])).toEqual(["Has a business", "Wants an LLC"])
    expect(cleanChecklist(Array.from({ length: 60 }, (_, i) => `Item ${i}`))).toHaveLength(40)
    expect(cleanChecklist(["x".repeat(200)])[0]).toHaveLength(80)
  })
})
