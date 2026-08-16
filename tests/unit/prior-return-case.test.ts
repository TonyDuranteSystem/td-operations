import { describe, it, expect } from "vitest"
import { firstYearCoherent, validatedExtraction, priorBeginningCta, buildCarriedForwardRecord, buildStaffCorrectionRecord, type CarryPayload } from "@/lib/tax/prior-return-case"

describe("firstYearCoherent (Case C cross-check, §13 A6)", () => {
  it("formed in the tax year → coherent", () => {
    expect(firstYearCoherent("2025-03-17", 2025)).toBe(true)
  })

  it("formed after the tax year start but claim says first year → still coherent (formed mid-year)", () => {
    expect(firstYearCoherent("2025-12-30", 2025)).toBe(true)
  })

  it("formed BEFORE the tax year → mismatch (prior returns may exist)", () => {
    expect(firstYearCoherent("2023-06-01", 2025)).toBe(false)
  })

  it("no formation date on file → null (cannot cross-check, recorded as such)", () => {
    expect(firstYearCoherent(null, 2025)).toBeNull()
  })

  it("garbage date → null, never throws", () => {
    expect(firstYearCoherent("not-a-date", 2025)).toBeNull()
  })
})

const payload = (over: Partial<CarryPayload> = {}): CarryPayload => ({
  beginning_cash: 391863.70,
  beginning_cta: -1234.56,
  members: [
    { contact_id: "c1", name: "Sofia Marinoni", beginning_capital: 216862.38 },
    { contact_id: "c2", name: "Donato Renato Berini", beginning_capital: 216862.38 },
  ],
  unresolved_members: [],
  ...over,
})

describe("buildCarriedForwardRecord / buildStaffCorrectionRecord (dev_task d909e086)", () => {
  it("carried_forward: honest case/source, extracted shape the engine already reads", () => {
    const rec = buildCarriedForwardRecord(payload(), 2024, "2026-08-14T00:00:00Z")
    expect(rec.case).toBe("carried_forward")
    expect(rec.status).toBe("validated")
    if (rec.case !== "carried_forward") throw new Error("narrowing")
    expect(rec.source).toBe("our_corrected_books")
    expect(rec.beginning_cta).toBeCloseTo(-1234.56, 2)
    expect(rec.extracted.schedule_l?.ending.cash).toBeCloseTo(391863.70, 2)
    expect(rec.extracted.k1s).toHaveLength(2)
    expect(rec.extracted.k1s.find(k => k.partner_name === "Sofia Marinoni")?.ending_capital).toBeCloseTo(216862.38, 2)
    // beginning column is always zeroed — nothing downstream reads it for these cases.
    expect(rec.extracted.schedule_l?.beginning.cash).toBe(0)
  })

  it("staff_corrected: distinct case/source from carried_forward, computed_by is the staff email", () => {
    const rec = buildStaffCorrectionRecord(payload(), 2024, "luca@tonydurante.us", "2026-08-14T00:00:00Z")
    expect(rec.case).toBe("staff_corrected")
    if (rec.case !== "staff_corrected") throw new Error("narrowing")
    expect(rec.source).toBe("staff_manual_correction")
    expect(rec.computed_by).toBe("luca@tonydurante.us")
    expect(rec.note).toContain("luca@tonydurante.us")
  })

  it("unresolved_members pass through untouched — excluded from extracted.k1s, named in the sibling field", () => {
    const rec = buildCarriedForwardRecord(payload({ unresolved_members: ["New Member"] }), 2024, "z")
    if (rec.case !== "carried_forward") throw new Error("narrowing")
    expect(rec.unresolved_members).toEqual(["New Member"])
    expect(rec.extracted.k1s.some(k => k.partner_name === "New Member")).toBe(false)
  })

  it("validatedExtraction recognizes BOTH new cases (round-3 bug-hunter blocker 1 — the one chokepoint accessor)", () => {
    const carried = buildCarriedForwardRecord(payload(), 2024, "z")
    const corrected = buildStaffCorrectionRecord(payload(), 2024, "staff@x", "z")
    expect(validatedExtraction(carried)?.k1s).toHaveLength(2)
    expect(validatedExtraction(corrected)?.k1s).toHaveLength(2)
  })
})

describe("priorBeginningCta", () => {
  it("reads beginning_cta off carried_forward / staff_corrected", () => {
    expect(priorBeginningCta(buildCarriedForwardRecord(payload({ beginning_cta: 500 }), 2024, "z"))).toBe(500)
  })
  it("0 for every other case — no other case predates the concept, so 0 is honest, not a guess", () => {
    expect(priorBeginningCta(null)).toBe(0)
    expect(priorBeginningCta({ case: "first_year", status: "first_year", formation_date: null, note: "", recorded_at: "z" })).toBe(0)
    expect(priorBeginningCta({ case: "we_filed", status: "on_file", tax_return_id: null, note: "", recorded_at: "z" })).toBe(0)
  })
})
