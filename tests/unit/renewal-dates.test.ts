import { describe, it, expect } from "vitest"
import { deriveRenewalDates, plusOneYear, normalizeStateCode } from "@/lib/operations/renewal-dates"

const EMPTY = { ra_renewal_date: null, annual_report_due_date: null, cmra_renewal_date: null }

describe("plusOneYear", () => {
  it("adds one year to a plain date", () => {
    expect(plusOneYear("2026-06-05")).toBe("2027-06-05")
  })
  it("Feb 29 overflows to Mar 1 (matches SD-completion roll-forward convention)", () => {
    expect(plusOneYear("2024-02-29")).toBe("2025-03-01")
  })
  it("year boundaries hold (Dec 31, Jan 1)", () => {
    expect(plusOneYear("2026-12-31")).toBe("2027-12-31")
    expect(plusOneYear("2026-01-01")).toBe("2027-01-01")
  })
})

describe("normalizeStateCode", () => {
  it("maps long names and passes codes through", () => {
    expect(normalizeStateCode("New Mexico")).toBe("NM")
    expect(normalizeStateCode("Wyoming")).toBe("WY")
    expect(normalizeStateCode("florida")).toBe("FL")
    expect(normalizeStateCode("DE")).toBe("DE")
    expect(normalizeStateCode(null)).toBe("")
  })
})

describe("deriveRenewalDates — RA renewal", () => {
  it("formation intake derives from formation_date even when client_since is set", () => {
    const fills = deriveRenewalDates({
      intake: "formation",
      formation_date: "2026-06-05",
      client_since: "2026-01-15", // bulk-editable field; must NOT win for formations
      state_of_formation: "New Mexico",
      existing: EMPTY,
      currentYear: 2026,
    })
    expect(fills.ra_renewal_date).toBe("2027-06-05")
  })

  it("onboarding intake derives from ra_switch_date first, then client_since — never formation_date", () => {
    const a = deriveRenewalDates({
      intake: "onboarding",
      formation_date: "2023-08-10",
      ra_switch_date: "2026-05-01",
      client_since: "2026-04-01",
      state_of_formation: "Wyoming",
      existing: EMPTY,
      currentYear: 2026,
    })
    expect(a.ra_renewal_date).toBe("2027-05-01")

    const b = deriveRenewalDates({
      intake: "onboarding",
      formation_date: "2023-08-10",
      ra_switch_date: null,
      client_since: "2026-04-18",
      state_of_formation: "Delaware",
      existing: EMPTY,
      currentYear: 2026,
    })
    expect(b.ra_renewal_date).toBe("2027-04-18")

    const c = deriveRenewalDates({
      intake: "onboarding",
      formation_date: "2023-08-10", // must NOT be used — would derive an already-past date
      state_of_formation: "Wyoming",
      existing: EMPTY,
      currentYear: 2026,
    })
    expect(c.ra_renewal_date).toBeUndefined()
  })

  it("never overwrites an existing (non-null) date", () => {
    const fills = deriveRenewalDates({
      intake: "formation",
      formation_date: "2026-06-05",
      state_of_formation: "New Mexico",
      existing: { ...EMPTY, ra_renewal_date: "2027-06-05" },
      currentYear: 2026,
    })
    expect(fills.ra_renewal_date).toBeUndefined()
  })

  it("no start date → no RA fill (null stays null, watchdog surfaces it)", () => {
    const fills = deriveRenewalDates({
      intake: "formation",
      formation_date: null,
      state_of_formation: "Florida",
      existing: EMPTY,
      currentYear: 2026,
    })
    expect(fills.ra_renewal_date).toBeUndefined()
  })
})

describe("deriveRenewalDates — annual report per state", () => {
  it("FL → May 1 next year; DE → Jun 1 next year", () => {
    const fl = deriveRenewalDates({ intake: "formation", formation_date: "2026-03-10", state_of_formation: "Florida", existing: EMPTY, currentYear: 2026 })
    expect(fl.annual_report_due_date).toBe("2027-05-01")
    const de = deriveRenewalDates({ intake: "onboarding", formation_date: "2025-05-06", client_since: "2026-03-25", state_of_formation: "Delaware", existing: EMPTY, currentYear: 2026 })
    expect(de.annual_report_due_date).toBe("2027-06-01")
  })
  it("WY → 1st of formation month next year", () => {
    const wy = deriveRenewalDates({ intake: "formation", formation_date: "2026-08-10", state_of_formation: "Wyoming", existing: EMPTY, currentYear: 2026 })
    expect(wy.annual_report_due_date).toBe("2027-08-01")
  })
  it("NM → never sets an annual report date", () => {
    const nm = deriveRenewalDates({ intake: "formation", formation_date: "2026-06-05", state_of_formation: "New Mexico", existing: EMPTY, currentYear: 2026 })
    expect(nm.annual_report_due_date).toBeUndefined()
  })
  it("existing AR date preserved", () => {
    const fills = deriveRenewalDates({
      intake: "onboarding",
      formation_date: "2025-06-03",
      client_since: "2026-05-01",
      state_of_formation: "Wyoming",
      existing: { ...EMPTY, annual_report_due_date: "2027-06-01" },
      currentYear: 2026,
    })
    expect(fills.annual_report_due_date).toBeUndefined()
  })
})

describe("deriveRenewalDates — CMRA", () => {
  it("fills Dec 31 of the current year when null; preserved when set", () => {
    const a = deriveRenewalDates({ intake: "formation", formation_date: "2026-06-05", state_of_formation: "NM", existing: EMPTY, currentYear: 2026 })
    expect(a.cmra_renewal_date).toBe("2026-12-31")
    const b = deriveRenewalDates({ intake: "formation", formation_date: "2026-06-05", state_of_formation: "NM", existing: { ...EMPTY, cmra_renewal_date: "2026-12-31" }, currentYear: 2026 })
    expect(b.cmra_renewal_date).toBeUndefined()
  })
})

describe("deriveRenewalDates — the 9 approved backfills (plan c2d97552 A1)", () => {
  const cases: Array<{ name: string; intake: "formation" | "onboarding"; formation_date: string | null; client_since?: string | null; expected: string }> = [
    { name: "ATCOACHING", intake: "onboarding", formation_date: "2025-05-06", client_since: "2026-03-25", expected: "2027-03-25" },
    { name: "2L Consulting", intake: "onboarding", formation_date: "2025-03-20", client_since: "2026-04-18", expected: "2027-04-18" },
    { name: "Infinity Commerce", intake: "onboarding", formation_date: "2025-06-03", client_since: "2026-05-01", expected: "2027-05-01" },
    { name: "AI Venture Labs", intake: "formation", formation_date: "2026-06-16", expected: "2027-06-16" },
    { name: "Automatiko", intake: "formation", formation_date: "2026-06-17", expected: "2027-06-17" },
    { name: "Numero Uno Social", intake: "formation", formation_date: "2026-06-18", expected: "2027-06-18" },
    { name: "Art of Profit Academy", intake: "formation", formation_date: "2026-06-25", expected: "2027-06-25" },
    { name: "E-commerce Empire New York", intake: "formation", formation_date: "2026-06-26", expected: "2027-06-26" },
    { name: "DoctorGut", intake: "formation", formation_date: "2026-07-09", expected: "2027-07-09" },
  ]
  for (const c of cases) {
    it(`${c.name} → ${c.expected}`, () => {
      const fills = deriveRenewalDates({
        intake: c.intake,
        formation_date: c.formation_date,
        client_since: c.client_since ?? null,
        ra_switch_date: c.intake === "onboarding" ? c.client_since ?? null : null,
        state_of_formation: "X", // state irrelevant for the RA date
        existing: EMPTY,
        currentYear: 2026,
      })
      expect(fills.ra_renewal_date).toBe(c.expected)
    })
  }
})
